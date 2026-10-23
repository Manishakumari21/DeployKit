import pool from "../db/database.js";

export interface ProjectEvent {
  id: string;
  deployment_id: string;
  event_type: string;
  status_from: string | null;
  status_to: string | null;
  message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  branch: string;
  commit_sha: string | null;
  trigger: string;
}

export async function getProjectEvents(
  projectId: string,
  limit = 50
): Promise<ProjectEvent[]> {
  const bounded = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), 100)
    : 50;
  const result = await pool.query<ProjectEvent>(
    `
    SELECT
      e.id,
      e.deployment_id,
      e.event_type,
      e.status_from,
      e.status_to,
      e.message,
      e.metadata,
      e.created_at,
      d.branch,
      d.commit_sha,
      d.trigger
    FROM deployment_events e
    JOIN deployments d ON d.id = e.deployment_id
    WHERE d.project_id = $1
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT $2
    `,
    [projectId, bounded]
  );
  return result.rows;
}
