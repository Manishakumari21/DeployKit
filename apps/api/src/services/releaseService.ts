import pool from "../db/database.js";

export type ReleaseStatus =
  | "pending"
  | "starting"
  | "healthy"
  | "active"
  | "stopped"
  | "failed";

export interface CreateReleaseInput {
  deploymentId: string;
  projectId: string;
  imageRepository: string;
  imageDigest: string;
  commitSha: string;
  branch: string;
  supersedesReleaseId: string | null;
}

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;

export async function createRelease(input: CreateReleaseInput) {
  if (!DIGEST_PATTERN.test(input.imageDigest)) {
    throw new Error("Release requires an immutable sha256 digest");
  }
  if (!/^[0-9a-f]{40}$/i.test(input.commitSha)) {
    throw new Error("Release requires a valid commit SHA");
  }
  if (!input.branch || input.branch.trim().length === 0) {
    throw new Error("Release requires a branch");
  }
  const dep = await pool.query(
    `
    SELECT id, project_id FROM deployments WHERE id = $1
    `,
    [input.deploymentId]
  );
  if (dep.rowCount === 0) throw new Error("Deployment not found");
  if (dep.rows[0].project_id !== input.projectId) throw new Error("Deployment does not belong to the requested project");
  let result;
  try {
    result = await pool.query(
      `
      INSERT INTO releases (
        deployment_id, project_id, image_repository, image_digest,
        commit_sha, branch, status, supersedes_release_id,
        started_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,'pending',$7, CURRENT_TIMESTAMP)
      ON CONFLICT (deployment_id)
      DO NOTHING
      RETURNING *
      `,
      [
        input.deploymentId,
        input.projectId,
        input.imageRepository,
        input.imageDigest,
        input.commitSha.toLowerCase(),
        input.branch,
        input.supersedesReleaseId,
      ]
    );
  } catch (error) {
    throw error;
  }
  if (result.rows.length === 0) {
    const existing = await pool.query(
      `
      SELECT * FROM releases WHERE deployment_id = $1
      `,
      [input.deploymentId]
    );
    if (existing.rowCount === 0) throw new Error("A release already exists for this deployment");
    return existing.rows[0];
  }
  return result.rows[0];
}

const RELEASE_TRANSITIONS: Record<ReleaseStatus, ReadonlySet<ReleaseStatus>> = {
  pending: new Set(["starting", "failed"]),
  starting: new Set(["healthy", "failed"]),
  healthy: new Set(["failed"]),
  active: new Set([]),
  stopped: new Set([]),
  failed: new Set([]),
};

export async function markRelease(
  releaseId: string,
  status: ReleaseStatus,
  error?: { code: string; message: string }
) {
  const current = await pool.query(
    `
    SELECT status FROM releases WHERE id = $1
    `,
    [releaseId]
  );
  if (current.rowCount === 0) throw new Error("Release not found");
  const from = current.rows[0].status as ReleaseStatus;
  if (from !== status && !RELEASE_TRANSITIONS[from]?.has(status)) {
    throw new Error(
      `Invalid release transition ${from} -> ${status}`
    );
  }
  const column =
    status === "healthy"
      ? "healthy_at"
      : status === "active"
        ? "activated_at"
        : status === "stopped"
          ? "stopped_at"
          : null;
  if (column) {
    await pool.query(
      `
      UPDATE releases
      SET status = $2,
          error_code = $3,
          error_message = $4,
          ${column} = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [
        releaseId,
        status,
        error?.code ?? null,
        error?.message?.slice(0, 4000) ?? null,
      ]
    );
  } else {
    await pool.query(
      `
      UPDATE releases
      SET status = $2, error_code = $3, error_message = $4
      WHERE id = $1
      `,
      [
        releaseId,
        status,
        error?.code ?? null,
        error?.message?.slice(0, 4000) ?? null,
      ]
    );
  }
}

export interface ActivationRoute {
  gatewayName: string;
  containerName: string;
  containerIp: string;
  containerPort: number;
}

export async function getReleaseForDeployment(deploymentId: string) {
  const result = await pool.query(
    `SELECT * FROM releases WHERE deployment_id = $1`,
    [deploymentId]
  );
  return result.rows[0] ?? null;
}

export async function activateRelease(
  projectId: string,
  releaseId: string,
  deploymentId: string,
  route: ActivationRoute | null = null
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `SELECT pg_advisory_xact_lock(810971722, hashtext($1))`,
      [projectId]
    );

    const target = await client.query(
      `
      SELECT id, project_id, status
      FROM releases
      WHERE id = $1
      FOR UPDATE
      `,
      [releaseId]
    );
    if (target.rowCount === 0) throw new Error("Release not found");
    if (target.rows[0].project_id !== projectId) throw new Error("Release does not belong to the requested project");
    if (target.rows[0].status === "active") {
      const linked = await client.query(
        `
        SELECT release_id FROM deployments
        WHERE id = $1 AND project_id = $2
        `,
        [deploymentId, projectId]
      );
      if (
        linked.rowCount === 1 &&
        linked.rows[0].release_id === releaseId
      ) {
        await client.query("COMMIT");
        return;
      }
      throw new Error("Release is already active");
    }
    if (target.rows[0].status !== "healthy") throw new Error("Release must be healthy before activation");

    const current = await client.query(
      `
      SELECT id FROM releases
      WHERE project_id = $1 AND status = 'active'
      FOR UPDATE
      `,
      [projectId]
    );
    const previousId: string | null =
      current.rows[0]?.id && current.rows[0].id !== releaseId
        ? current.rows[0].id
        : null;

    if (previousId) {
      await client.query(
        `
        UPDATE releases
        SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [previousId]
      );
    }

    await client.query(
      `
      UPDATE releases
      SET status = 'active', activated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [releaseId]
    );

    const depUpdate = await client.query(
      `
      UPDATE deployments
      SET release_id = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND project_id = $3
      `,
      [deploymentId, releaseId, projectId]
    );
    if (depUpdate.rowCount !== 1) throw new Error("Deployment not found for the requested project");

    if (route) {
      if (
        !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(route.gatewayName) ||
        !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(route.containerName) ||
        !/^(\d{1,3}\.){3}\d{1,3}$/.test(route.containerIp) ||
        !Number.isInteger(route.containerPort) ||
        route.containerPort < 1 ||
        route.containerPort > 65535
      ) {
        throw new Error("Invalid activation route");
      }
      await client.query(
        `
        INSERT INTO project_gateways (
          project_id, gateway_name, active_release_id,
          target_container, target_ip, target_port, config_rev
        )
        VALUES ($1, $2, $3, $4, $5, $6, 1)
        ON CONFLICT (project_id)
        DO UPDATE SET gateway_name = EXCLUDED.gateway_name,
                      active_release_id = EXCLUDED.active_release_id,
                      target_container = EXCLUDED.target_container,
                      target_ip = EXCLUDED.target_ip,
                      target_port = EXCLUDED.target_port,
                      config_rev = project_gateways.config_rev + 1,
                      updated_at = CURRENT_TIMESTAMP
        `,
        [
          projectId,
          route.gatewayName,
          releaseId,
          route.containerName,
          route.containerIp,
          route.containerPort,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getActiveRelease(projectId: string) {
  const result = await pool.query(
    `SELECT * FROM releases WHERE project_id = $1 AND status = 'active' LIMIT 1`,
    [projectId]
  );
  return result.rows[0] ?? null;
}

export async function getProjectReleases(projectId: string) {
  const result = await pool.query(
    `SELECT * FROM releases WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [projectId]
  );
  return result.rows;
}

export async function getReleaseById(id: string) {
  const result = await pool.query(
    `SELECT * FROM releases WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}
