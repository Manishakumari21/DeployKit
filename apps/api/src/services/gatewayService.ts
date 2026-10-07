import { readFile } from "node:fs/promises";
import pool from "../db/database.js";
import {
  TrafficRouterError,
  validateRouteTarget,
  type RouteTarget,
  type TlsRouteEntry,
  type TrafficRouter,
} from "../infrastructure/gateway/trafficRouter.js";
import { NginxGatewayRouter } from "../infrastructure/gateway/nginxGatewayRouter.js";
import { certsDir, fullchainPath, gatewayCertPaths } from "../tls/certPaths.js";
import { validateCertificateForDomain } from "../tls/certValidation.js";

export async function getProjectGateway(projectId: string) {
  const result = await pool.query(
    `SELECT * FROM project_gateways WHERE project_id = $1`,
    [projectId]
  );
  return result.rows[0] ?? null;
}

export async function resolveActiveRoute(projectId: string): Promise<RouteTarget | null> {
  const result = await pool.query(
    `
    SELECT r.id AS release_id, i.container_name, i.ip_address, i.container_port
    FROM releases r
    JOIN runtime_instances i ON i.release_id = r.id
    WHERE r.project_id = $1
      AND r.status = 'active'
      AND i.status IN ('running', 'starting')
    ORDER BY i.last_health_check_at DESC NULLS LAST, i.created_at DESC
    LIMIT 1
    `,
    [projectId]
  );
  if (result.rowCount === 0) {
    return null;
  }
  const row = result.rows[0];
  if (!row.ip_address) {
    return null;
  }
  try {
    return validateRouteTarget({
      projectId,
      releaseId: row.release_id,
      containerName: row.container_name,
      containerIp: row.ip_address,
      containerPort: row.container_port,
    });
  } catch {
    return null;
  }
}

export async function resolveValidTlsEntries(
  projectId: string,
  root: string = certsDir()
): Promise<TlsRouteEntry[]> {
  const result = await pool.query(
    `
    SELECT domain, tls_status
    FROM custom_domains
    WHERE project_id = $1
      AND status = 'verified'
      AND tls_status IN ('issued', 'renewing')
    ORDER BY domain ASC
    `,
    [projectId]
  );
  const entries: TlsRouteEntry[] = [];
  for (const row of result.rows as Array<{ domain: string; tls_status: string }>) {
    let pem: string;
    try {
      pem = await readFile(fullchainPath(row.domain, root), "utf8");
    } catch {
      continue;
    }
    if (pem.length > 64 * 1024) continue;
    try {
      validateCertificateForDomain(pem, row.domain);
    } catch {
      continue;
    }
    const gateway = gatewayCertPaths(row.domain);
    entries.push({
      domain: row.domain,
      certificateFile: gateway.certificate,
      keyFile: gateway.key,
    });
  }
  return entries;
}

interface SyncTargetOptions {
  excludeDomains?: string[];
  router?: TrafficRouter;
  timeoutMs?: number;
  certsRoot?: string;
}

export async function syncProjectTarget(
  projectId: string,
  target: RouteTarget,
  options: SyncTargetOptions = {}
): Promise<{ target: RouteTarget; tlsDomains: string[] }> {
  const router = options.router ?? new NginxGatewayRouter();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const excluded = new Set((options.excludeDomains ?? []).map((d) => d.trim().toLowerCase()));
  const { getVerifiedDomains } = await import("./domainService.js");
  const domains = (await getVerifiedDomains(projectId)).filter((d) => !excluded.has(d));
  const tls = (await resolveValidTlsEntries(projectId, options.certsRoot)).filter(
    (entry) => !excluded.has(entry.domain)
  );
  const previous =
    typeof (router as unknown as { readRawConfig?: (id: string) => Promise<string | null> })
      .readRawConfig === "function"
      ? await (
          router as unknown as { readRawConfig: (id: string) => Promise<string | null> }
        ).readRawConfig(projectId)
      : null;
  const restore = async (): Promise<void> => {
    const restorable = router as unknown as {
      restoreRawConfig?: (id: string, prev: string | null) => Promise<void>;
    };
    if (typeof restorable.restoreRawConfig === "function") {
      try {
        await restorable.restoreRawConfig(projectId, previous);
      } catch {
      }
    }
  };
  await router.sync(target, domains, tls);
  try {
    await router.verifyRoute(target, timeoutMs);
    for (const entry of tls) {
      if (typeof router.verifyHttpsRoute === "function") {
        await router.verifyHttpsRoute(target, entry.domain, Math.min(timeoutMs, 10_000));
      }
    }
  } catch (error) {
    await restore();
    throw error;
  }
  return { target, tlsDomains: tls.map((entry) => entry.domain) };
}

export async function syncProjectGateway(
  projectId: string,
  router: TrafficRouter = new NginxGatewayRouter(),
  timeoutMs = 30_000
): Promise<RouteTarget> {
  const target = await resolveActiveRoute(projectId);
  if (!target) {
    throw new TrafficRouterError("NO_ACTIVE_ROUTE", "Project has no healthy active runtime to route");
  }
  const { target: synced } = await syncProjectTarget(projectId, target, { router, timeoutMs });
  return synced;
}
