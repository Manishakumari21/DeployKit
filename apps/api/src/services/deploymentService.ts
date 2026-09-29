import pool from "../db/database.js";

export type DeploymentTrigger =
  | "manual"
  | "github_push"
  | "rollback";

export interface CreateDeploymentInput {
  projectId: string;
  trigger: DeploymentTrigger;
  idempotencyKey: string | null;
}

export async function createDeployment(
  input: CreateDeploymentInput
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const projectResult = await client.query(
      `
      SELECT id, branch
      FROM projects
      WHERE id = $1
      FOR SHARE
      `,
      [input.projectId]
    );

    if (projectResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const project = projectResult.rows[0];

    let deployment;

    if (input.idempotencyKey) {
      const insertResult = await client.query(
        `
        INSERT INTO deployments (
          project_id,
          status,
          trigger,
          branch,
          idempotency_key
        )
        VALUES ($1, 'queued', $2, $3, $4)
        ON CONFLICT (
          project_id,
          idempotency_key
        )
        WHERE idempotency_key IS NOT NULL
        DO NOTHING
        RETURNING *
        `,
        [
          input.projectId,
          input.trigger,
          project.branch,
          input.idempotencyKey,
        ]
      );

      if (insertResult.rows.length > 0) {
        deployment = insertResult.rows[0];
      } else {
        const existingResult = await client.query(
          `
          SELECT *
          FROM deployments
          WHERE project_id = $1
            AND idempotency_key = $2
          LIMIT 1
          `,
          [input.projectId, input.idempotencyKey]
        );

        deployment = existingResult.rows[0];
      }
    } else {
      const insertResult = await client.query(
        `
        INSERT INTO deployments (
          project_id,
          status,
          trigger,
          branch
        )
        VALUES ($1, 'queued', $2, $3)
        RETURNING *
        `,
        [
          input.projectId,
          input.trigger,
          project.branch,
        ]
      );

      deployment = insertResult.rows[0];
    }

    if (!deployment) {
      throw new Error("Failed to create deployment");
    }

    const jobResult = await client.query(
      `
      INSERT INTO deployment_jobs (
        deployment_id,
        status,
        attempts,
        max_attempts
      )
      VALUES ($1, 'queued', 0, 3)
      ON CONFLICT (deployment_id)
      DO NOTHING
      RETURNING *
      `,
      [deployment.id]
    );

    if (jobResult.rows.length > 0) {
      await client.query(
        `
        INSERT INTO deployment_events (
          deployment_id,
          event_type,
          status_from,
          status_to,
          message,
          metadata
        )
        VALUES (
          $1,
          'deployment.queued',
          NULL,
          'queued',
          $2,
          $3::jsonb
        )
        `,
        [
          deployment.id,
          "Deployment queued",
          JSON.stringify({
            trigger: deployment.trigger,
            branch: deployment.branch,
          }),
        ]
      );
    }

    await client.query("COMMIT");

    return deployment;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getDeploymentById(id: string) {
  const result = await pool.query(
    `
    SELECT
      d.*,
      p.name AS project_name,
      j.status AS job_status,
      j.attempts AS job_attempts,
      j.max_attempts
    FROM deployments d
    JOIN projects p
      ON p.id = d.project_id
    LEFT JOIN deployment_jobs j
      ON j.deployment_id = d.id
    WHERE d.id = $1
    `,
    [id]
  );

  return result.rows[0] ?? null;
}

export async function getProjectDeployments(projectId: string) {
  const result = await pool.query(
    `
    SELECT
      d.*,
      j.status AS job_status,
      j.attempts AS job_attempts,
      j.max_attempts
    FROM deployments d
    LEFT JOIN deployment_jobs j
      ON j.deployment_id = d.id
    WHERE d.project_id = $1
    ORDER BY d.created_at DESC
    `,
    [projectId]
  );

  return result.rows;
}
