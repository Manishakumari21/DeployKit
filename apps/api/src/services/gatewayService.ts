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

export type GatewayReconcileStatus =
  | "reconciled"
  | "no-active-route"
  | "superseded";

export interface GatewayReconcileResult {
  status: GatewayReconcileStatus;
  releaseId: string | null;
}

export interface ReconcileOptions {
  router?: TrafficRouter;
  timeoutMs?: number;
  maxRounds?: number;
}

export async function reconcileProjectGateway(
  projectId: string,
  options: ReconcileOptions = {}
): Promise<GatewayReconcileResult> {
  const router = options.router ?? new NginxGatewayRouter();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRounds = options.maxRounds ?? 3;
  let lastReleaseId: string | null = null;
  for (let round = 0; round < Math.max(1, maxRounds); round += 1) {
    const target = await resolveActiveRoute(projectId);
    if (!target) {
      return { status: "no-active-route", releaseId: null };
    }
    await syncProjectTarget(projectId, target, { router, timeoutMs });
    const current = await resolveActiveRoute(projectId);
    if (!current) {
      return { status: "no-active-route", releaseId: null };
    }
    lastReleaseId = current.releaseId;
    if (current.releaseId === target.releaseId) {
      return { status: "reconciled", releaseId: target.releaseId };
    }
  }
  return { status: "superseded", releaseId: lastReleaseId };
}

export interface GatewayReconcileSummary {
  reconciled: number;
  skipped: number;
  failed: number;
  superseded: number;
}

export async function reconcileActiveGateways(
  options: ReconcileOptions & {
    createRouter?: (projectId: string) => TrafficRouter;
    onProjectError?: (projectId: string, error: unknown) => void;
  } = {}
): Promise<GatewayReconcileSummary> {
  const summary: GatewayReconcileSummary = {
    reconciled: 0,
    skipped: 0,
    failed: 0,
    superseded: 0,
  };
  const rows = await pool.query(
    `SELECT DISTINCT project_id FROM releases WHERE status = 'active'`
  );
  for (const row of rows.rows as Array<{ project_id: string }>) {
    try {
      const result = await reconcileProjectGateway(row.project_id, {
        router: options.createRouter ? options.createRouter(row.project_id) : (options.router ?? new NginxGatewayRouter()),
        timeoutMs: options.timeoutMs,
        maxRounds: options.maxRounds,
      });
      if (result.status === "reconciled") summary.reconciled += 1;
      else if (result.status === "no-active-route") summary.skipped += 1;
      else summary.superseded += 1;
    } catch (error) {
      summary.failed += 1;
      try {
        options.onProjectError?.(row.project_id, error);
      } catch {
      }
    }
  }
  return summary;
}
