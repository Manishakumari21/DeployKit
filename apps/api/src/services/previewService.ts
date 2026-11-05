import pool from "../db/database.js";
import { createHash } from "node:crypto";
import { DockerRuntimeManager } from "../infrastructure/runtime/dockerRuntimeManager.js";
import type { RuntimeManager } from "../infrastructure/runtime/runtimeManager.js";
import { NginxGatewayRouter } from "../infrastructure/gateway/nginxGatewayRouter.js";
import type { TrafficRouter } from "../infrastructure/gateway/trafficRouter.js";
import { cancelDeployment, NON_TERMINAL_DEPLOYMENT_STATUSES } from "./deploymentService.js";

export interface PreviewProjectRow {
  id: string;
  name: string;
  repository_url: string;
  branch: string;
  github_repository_id: string | null;
  auto_deploy: boolean;
  parent_project_id: string;
  pr_number: number;
  is_preview: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

export function generatePreviewDomain(parentProjectId: string, prNumber: number, baseDomain: string): string {
  const short = parentProjectId.replace(/-/g, "").slice(0, 8).toLowerCase();
  return `pr-${prNumber}-${short}.${baseDomain.trim().toLowerCase()}`;
}

export async function findPreviewProject(
  parentProjectId: string,
  prNumber: number
): Promise<PreviewProjectRow | null> {
  const result = await pool.query<PreviewProjectRow>(
    `SELECT * FROM projects WHERE parent_project_id = $1 AND pr_number = $2 LIMIT 1`,
    [parentProjectId, prNumber]
  );
  return result.rows[0] ?? null;
}

export async function findOrCreatePreviewProject(input: {
  parentProjectId: string;
  prNumber: number;
  prHeadRef: string;
}): Promise<PreviewProjectRow> {
  const { parentProjectId, prNumber, prHeadRef } = input;

  const existing = await findPreviewProject(parentProjectId, prNumber);
  if (existing) {
    if (existing.branch !== prHeadRef) {
      const updated = await pool.query<PreviewProjectRow>(
        `UPDATE projects SET branch = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
        [prHeadRef, existing.id]
      );
      return updated.rows[0];
    }
    return existing;
  }

  const parentResult = await pool.query(
    `SELECT id, name, repository_url, github_repository_id FROM projects WHERE id = $1`,
    [parentProjectId]
  );
  if (parentResult.rowCount === 0) {
    throw new Error("Parent project not found");
  }
  const parent = parentResult.rows[0];
  const previewName = `${parent.name}-pr-${prNumber}`.slice(0, 100);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insertResult = await client.query<PreviewProjectRow>(
      `INSERT INTO projects (
        name,
        repository_url,
        branch,
        github_repository_id,
        auto_deploy,
        parent_project_id,
        pr_number,
        is_preview
      ) VALUES ($1, $2, $3, $4, true, $5, $6, true)
      ON CONFLICT (parent_project_id, pr_number) WHERE parent_project_id IS NOT NULL
      DO UPDATE SET branch = EXCLUDED.branch, updated_at = CURRENT_TIMESTAMP
      RETURNING *`,
      [
        previewName,
        parent.repository_url,
        prHeadRef,
        parent.github_repository_id ?? null,
        parentProjectId,
        prNumber,
      ]
    );
    const previewProject = insertResult.rows[0];

    // Parent membership controls who can read the preview project.
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role)
       SELECT $1, user_id, role
       FROM project_members
       WHERE project_id = $2
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [previewProject.id, parentProjectId]
    );

    const previewDomainBase = process.env.DEPLOYKIT_PREVIEW_DOMAIN?.trim();
    if (previewDomainBase) {
      const previewDomain = generatePreviewDomain(parentProjectId, prNumber, previewDomainBase);
      await client.query(
        `INSERT INTO custom_domains (
           project_id,
           domain,
           status,
           verification_token_hash,
           verification_expires_at
         ) VALUES ($1, $2, 'verified', $3, NOW() + interval '100 years')
         ON CONFLICT (lower(domain)) DO NOTHING`,
        [
          previewProject.id,
          previewDomain,
          previewDomainTokenHash(previewDomain),
        ]
      );
    }

    await client.query("COMMIT");
    return previewProject;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The column stores 64 hex chars by contract, so preview domains get a
 * deterministic placeholder; verification is skipped because subdomains of a
 * base domain the operator already owns are inherently trusted.
 */
function previewDomainTokenHash(domain: string): string {
  return createHash("sha256").update(`preview-domain:${domain}`).digest("hex");
}

export async function teardownPreviewProject(
  previewProjectId: string,
  dependencies: {
    runtimeManager?: RuntimeManager;
    trafficRouter?: TrafficRouter;
  } = {}
): Promise<void> {
  // Cancel queued/running builds first so a racing job cannot recreate
  // containers after the project rows are gone.
  const inFlight = await pool.query(
    `SELECT id FROM deployments
     WHERE project_id = $1 AND status = ANY($2::deployment_status[])`,
    [previewProjectId, [...NON_TERMINAL_DEPLOYMENT_STATUSES]]
  );
  for (const row of inFlight.rows as Array<{ id: string }>) {
    await cancelDeployment(row.id).catch(() => undefined);
  }

  const containerRows = await pool.query<{ container_name: string }>(
    `SELECT ri.container_name
     FROM runtime_instances ri
     JOIN releases r ON r.id = ri.release_id
     WHERE r.project_id = $1`,
    [previewProjectId]
  );

  const runtimeManager = dependencies.runtimeManager ?? new DockerRuntimeManager();
  for (const { container_name } of containerRows.rows) {
    try {
      await runtimeManager.stop(container_name);
    } catch {
      // Best-effort stop; teardown must not fail on an already-dead container.
    }
    try {
      await runtimeManager.remove(container_name);
    } catch {
      // Best-effort remove.
    }
  }

  const router = dependencies.trafficRouter ?? new NginxGatewayRouter();
  try {
    await router.remove(previewProjectId);
  } catch {
    // No central route exists for cluster-internal-only previews.
  }

  await pool.query(`DELETE FROM projects WHERE id = $1`, [previewProjectId]);
}
