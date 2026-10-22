import pool from "../db/database.js";
import { DockerRuntimeManager } from "../infrastructure/runtime/dockerRuntimeManager.js";
import type { RuntimeManager } from "../infrastructure/runtime/runtimeManager.js";
import { NginxGatewayRouter } from "../infrastructure/gateway/nginxGatewayRouter.js";

export interface RuntimeHealthSummary {
  checked: number;
  healthy: number;
  unhealthy: number;
  skipped: number;
  failed: number;
}

export interface RuntimeHealthDependencies {
  runtimeManager?: Pick<RuntimeManager, "isRunning">;
  gracePeriodMs?: number;
  now?: () => Date;
}

interface MonitoredRuntime {
  instance_id: string;
  release_id: string;
  deployment_id: string;
  project_id: string;
  container_name: string;
  status: string;
  started_at: Date | null;
}

const DEFAULT_GRACE_PERIOD_MS = 30_000;

export async function checkActiveRuntimeHealth(
  deps: RuntimeHealthDependencies = {}
): Promise<RuntimeHealthSummary> {
  const runtimeManager = deps.runtimeManager ?? new DockerRuntimeManager();
  const gracePeriodMs = deps.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const now = deps.now ?? (() => new Date());
  const summary: RuntimeHealthSummary = {
    checked: 0,
    healthy: 0,
    unhealthy: 0,
    skipped: 0,
    failed: 0,
  };


  const rows = await pool.query(
    `
    SELECT
      i.id AS instance_id,
      i.release_id,
      r.deployment_id,
      r.project_id,
      i.container_name,
      i.status,
      i.started_at
    FROM runtime_instances i
    JOIN releases r ON r.id = i.release_id
    WHERE r.status = 'active'
      AND i.status IN ('running', 'starting', 'unhealthy')
    ORDER BY i.created_at ASC
    `
  );

  const current = now();
  for (const row of rows.rows as MonitoredRuntime[]) {
    let startedAtMs: number | null = null;
    const startedAt = row.started_at as unknown;
    if (startedAt instanceof Date) {
      startedAtMs = startedAt.getTime();
    } else if (typeof startedAt === "number") {
      startedAtMs = startedAt;
    } else if (typeof startedAt === "string") {
      const parsed = Date.parse(startedAt);
      if (!Number.isNaN(parsed)) startedAtMs = parsed;
      else {
        const parsed2 = Date.parse(startedAt.replace(" ", "T") + "Z");
        if (!Number.isNaN(parsed2)) startedAtMs = parsed2;
      }
    } else if (startedAt && typeof startedAt === "object") {
      const maybeDate = startedAt as { getTime?: () => number; toISOString?: () => string; valueOf?: () => number };
      if (typeof maybeDate.getTime === "function") {
        try { startedAtMs = maybeDate.getTime(); } catch {}
      }
      if (startedAtMs === null && typeof maybeDate.valueOf === "function") {
        const v = maybeDate.valueOf();
        if (typeof v === "number") startedAtMs = v;
      }
      if (startedAtMs === null && typeof maybeDate.toISOString === "function") {
        try {
          const parsed = Date.parse(maybeDate.toISOString());
          if (!Number.isNaN(parsed)) startedAtMs = parsed;
        } catch {}
      }
    }
    if (startedAtMs !== null && gracePeriodMs > 0 && current.getTime() - startedAtMs < gracePeriodMs) {
      summary.skipped += 1;
      continue;
    }
    if (startedAtMs === null && gracePeriodMs > 0) {
      summary.skipped += 1;
      continue;
    }

    summary.checked += 1;
    let running: boolean;
    try {
      if (typeof runtimeManager.isRunning !== "function") {
        summary.skipped += 1;
        summary.checked -= 1;
        continue;
      }
      running = await runtimeManager.isRunning(row.container_name);
    } catch (error) {
      summary.failed += 1;
      await recordHealthEvent(row, "runtime.health_check_failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      continue;
    }

    if (running) {
      summary.healthy += 1;
      await pool.query(
        `
        UPDATE runtime_instances
        SET status = 'running',
            error_code = NULL,
            error_message = NULL,
            last_health_check_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [row.instance_id]
      );
      continue;
    }

    summary.unhealthy += 1;
    const message = `Runtime container ${row.container_name} is not running`;
    await pool.query(
      `
      UPDATE runtime_instances
      SET status = 'unhealthy',
          error_code = 'RUNTIME_CONTAINER_NOT_RUNNING',
          error_message = $2,
          last_health_check_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [row.instance_id, message]
    );
    await pool.query(
      `
      UPDATE releases
      SET error_code = 'RUNTIME_CONTAINER_NOT_RUNNING',
          error_message = $2
      WHERE id = $1 AND status = 'active'
      `,
      [row.release_id, message]
    );
    await recordHealthEvent(row, "runtime.unhealthy", {
      containerName: row.container_name,
      previousStatus: row.status,
    });
    try {
      const router = new NginxGatewayRouter();
      await router.remove(row.project_id);
    } catch {
      // Best-effort cleanup; the unhealthy runtime row remains the source of truth.
    }
  }

  return summary;
}

async function recordHealthEvent(
  row: MonitoredRuntime,
  eventType: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await pool.query(
      `
      INSERT INTO deployment_events (
        deployment_id, event_type, status_from, status_to,
        message, metadata
      )
      VALUES ($1,$2,NULL,NULL,$3,$4::jsonb)
      `,
      [
        row.deployment_id,
        eventType,
        eventType === "runtime.unhealthy"
          ? `Runtime container ${row.container_name} is not running`
          : `Runtime health check failed for ${row.container_name}`,
        JSON.stringify(metadata),
      ]
    );
  } catch {
  }
}


