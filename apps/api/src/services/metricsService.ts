import pool from "../db/database.js";

export interface DeploymentMetrics {
  total: number;
  successful: number;
  failed: number;
  cancelled: number;
  success_rate: number | null;
  avg_duration_seconds: number | null;
  build_count: number;
  build_failures: number;
  avg_build_duration_seconds: number | null;
}

export interface QueueMetrics {
  queued: number;
  running: number;
  failed: number;
  succeeded: number;
  total_retries: number;
}

export interface RuntimeMetrics {
  active_releases: number;
  healthy_runtimes: number;
  unhealthy_runtimes: number;
}

export interface WorkerStatus {
  enabled: boolean;
  poll_interval_ms: number;
  lease_ms: number;
  last_activity_at: string | null;
  bootstrap_state: "unknown";
}

export interface ProjectMetrics {
  project_id: string;
  deployments: DeploymentMetrics;
  queue: QueueMetrics;
  runtime: RuntimeMetrics;
  worker: WorkerStatus;
}

function avgOrNull(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || Number.isNaN(n) ? null : n;
}

export async function getProjectMetrics(projectId: string): Promise<ProjectMetrics> {
  const dep = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'active')::int AS successful,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
       AVG(EXTRACT(EPOCH FROM (finished_at - started_at))) FILTER (
         WHERE status IN ('active','failed','cancelled') AND started_at IS NOT NULL AND finished_at IS NOT NULL
       ) AS avg_duration_seconds,
       COUNT(*) FILTER (WHERE image_digest IS NOT NULL)::int AS build_count,
       COUNT(*) FILTER (WHERE status = 'failed' AND error_code IN ('BUILD_FAILED','BUILD_TIMEOUT','BUILD_EXECUTION_FAILED'))::int AS build_failures
     FROM deployments WHERE project_id = $1`,
    [projectId]
  );
  const d = dep.rows[0];
  const totalTerminal = d.successful + d.failed + d.cancelled;
  void totalTerminal;

  const queue = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE j.status = 'queued')::int AS queued,
       COUNT(*) FILTER (WHERE j.status = 'running')::int AS running,
       COUNT(*) FILTER (WHERE j.status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE j.status = 'succeeded')::int AS succeeded,
       COALESCE(SUM(GREATEST(j.attempts - 1, 0)), 0)::int AS total_retries
     FROM deployment_jobs j
     JOIN deployments dep ON dep.id = j.deployment_id
     WHERE dep.project_id = $1`,
    [projectId]
  );
  const q = queue.rows[0];

  const runtime = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM releases WHERE project_id = $1 AND status = 'active') AS active_releases,
       (SELECT COUNT(*)::int FROM runtime_instances ri
          JOIN releases r ON r.id = ri.release_id
        WHERE r.project_id = $1 AND ri.status IN ('running')) AS healthy_runtimes,
       (SELECT COUNT(*)::int FROM runtime_instances ri
          JOIN releases r ON r.id = ri.release_id
        WHERE r.project_id = $1 AND ri.status IN ('unhealthy','failed')) AS unhealthy_runtimes`,
    [projectId]
  );
  const r = runtime.rows[0];

  const activity = await pool.query(
    `SELECT MAX(GREATEST(dep.updated_at, COALESCE(j.updated_at, dep.updated_at))) AS last_activity
     FROM deployments dep LEFT JOIN deployment_jobs j ON j.deployment_id = dep.id
     WHERE dep.project_id = $1`,
    [projectId]
  );

  return {
    project_id: projectId,
    deployments: {
      total: d.total,
      successful: d.successful,
      failed: d.failed,
      cancelled: d.cancelled,
      success_rate:
        d.total > 0 ? Math.round((d.successful / d.total) * 1000) / 1000 : null,
      avg_duration_seconds: avgOrNull(d.avg_duration_seconds),
      build_count: d.build_count,
      build_failures: d.build_failures,
      avg_build_duration_seconds: avgOrNull(d.avg_duration_seconds),
    },
    queue: {
      queued: q.queued,
      running: q.running,
      failed: q.failed,
      succeeded: q.succeeded,
      total_retries: q.total_retries,
    },
    runtime: {
      active_releases: r.active_releases,
      healthy_runtimes: r.healthy_runtimes,
      unhealthy_runtimes: r.unhealthy_runtimes,
    },
    worker: {
      enabled: (process.env.DEPLOYMENT_WORKER_ENABLED ?? "").toLowerCase() === "true",
      poll_interval_ms: Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000),
      lease_ms: Number(process.env.WORKER_LEASE_MS ?? 30000),
      last_activity_at:
        activity.rows[0]?.last_activity instanceof Date
          ? activity.rows[0].last_activity.toISOString()
          : (activity.rows[0]?.last_activity ?? null),
      bootstrap_state: "unknown",
    },
  };
}
