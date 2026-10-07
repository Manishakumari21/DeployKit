import pool from "../db/database.js";
import {
  TrafficRouterError,
  validateRouteTarget,
  type RouteTarget,
  type TrafficRouter,
} from "../infrastructure/gateway/trafficRouter.js";
import { NginxGatewayRouter } from "../infrastructure/gateway/nginxGatewayRouter.js";

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

export async function syncProjectGateway(
  projectId: string,
  router: TrafficRouter = new NginxGatewayRouter(),
  timeoutMs = 30_000
): Promise<RouteTarget> {
  const target = await resolveActiveRoute(projectId);
  if (!target) {
    throw new TrafficRouterError("NO_ACTIVE_ROUTE", "Project has no healthy active runtime to route");
  }
  // WHY: custom domains follow the active release. One query fetches the
  // verified aliases; the target (IP/port) still comes only from
  // project_gateways/runtime — never from user input.
  const { getVerifiedDomains } = await import("./domainService.js");
  const domains = await getVerifiedDomains(projectId);
  const previous =
    typeof (router as unknown as { readRawConfig?: (id: string) => Promise<string | null> })
      .readRawConfig === "function"
      ? await (
          router as unknown as { readRawConfig: (id: string) => Promise<string | null> }
        ).readRawConfig(projectId)
      : null;
  try {
    await router.sync(target, domains);
  } catch (error) {
    throw error;
  }
  try {
    await router.verifyRoute(target, timeoutMs);
  } catch (error) {
    // Verification failed: restore the previous known-good projection so
    // the existing active route keeps serving, then report the failure.
    const restorable = router as unknown as {
      restoreRawConfig?: (id: string, prev: string | null) => Promise<void>;
    };
    if (typeof restorable.restoreRawConfig === "function") {
      try {
        await restorable.restoreRawConfig(projectId, previous);
      } catch {
        // Best-effort restore; original verification error is authoritative.
      }
    }
    throw error;
  }
  return target;
}
