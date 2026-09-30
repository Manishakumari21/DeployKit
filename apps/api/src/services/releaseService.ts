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

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;

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
  if (dep.rowCount === 0) {
    throw new Error("Deployment not found");
  }
  if (dep.rows[0].project_id !== input.projectId) {
    throw new Error(
      "Deployment does not belong to the requested project"
    );
  }
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
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw new Error(
        "A release already exists for this deployment"
      );
    }
    throw error;
  }
  return result.rows[0];
}

export async function markRelease(
  releaseId: string,
  status: ReleaseStatus,
  error?: { code: string; message: string }
) {
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

export async function activateRelease(
  projectId: string,
  releaseId: string,
  deploymentId: string
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
    if (target.rowCount === 0) {
      throw new Error("Release not found");
    }
    if (target.rows[0].project_id !== projectId) {
      throw new Error(
        "Release does not belong to the requested project"
      );
    }
    if (target.rows[0].status !== "healthy") {
      throw new Error(
        "Release must be healthy before activation"
      );
    }

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
    if (depUpdate.rowCount !== 1) {
      throw new Error(
        "Deployment not found for the requested project"
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
