import pool from "../db/database.js";
import {
  assertTransition,
  type DeploymentStatus,
} from "../deployments/deploymentStateMachine.js";
import { recordDeploymentEvent } from "../deployments/deploymentEvents.js";
import { AgentError, getAgentById } from "../agents/agentService.js";

export type DeploymentTrigger =
  | "manual"
  | "github_push"
  | "rollback";

export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export interface CreateDeploymentInput {
  projectId: string;
  trigger: DeploymentTrigger;
  idempotencyKey: string | null;
  rollbackReleaseId?: string | null;
  commitSha?: string | null;

  targetAgentId?: string | null;
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

    if (input.trigger === "rollback") {
      if (!input.rollbackReleaseId) {
        await client.query("ROLLBACK");
        throw new Error("rollback_release_id is required");
      }
      const rel = await client.query(
        `
        SELECT id, project_id, status
        FROM releases
        WHERE id = $1
        `,
        [input.rollbackReleaseId]
      );
      if (
        rel.rowCount === 0 ||
        rel.rows[0].project_id !== input.projectId
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (rel.rows[0].status === "failed") {
        await client.query("ROLLBACK");
        throw new Error("Cannot rollback to a failed release");
      }
    } else if (input.rollbackReleaseId) {
      await client.query("ROLLBACK");
      throw new Error("rollback_release_id is only valid for rollback trigger");
    }

    let targetAgentId: string | null = null;
    if (input.targetAgentId !== undefined && input.targetAgentId !== null) {
      const agent = await getAgentById(input.targetAgentId);
      if (!agent) {
        await client.query("ROLLBACK");
        throw new AgentError(
          "TARGET_AGENT_NOT_FOUND",
          "Target agent not found",
          404
        );
      }
      if (agent.projectId !== input.projectId) {
        await client.query("ROLLBACK");
        throw new AgentError(
          "TARGET_AGENT_PROJECT_MISMATCH",
          "Target agent belongs to another project",
          400
        );
      }
      if (agent.status === "revoked") {
        await client.query("ROLLBACK");
        throw new AgentError(
          "TARGET_AGENT_REVOKED",
          "Target agent is revoked",
          422
        );
      }
      targetAgentId = agent.id;
    }

    let commitSha: string | null = null;
    if (input.commitSha !== undefined && input.commitSha !== null) {
      const normalized = input.commitSha.trim().toLowerCase();
      if (!COMMIT_SHA_PATTERN.test(normalized)) {
        await client.query("ROLLBACK");
        throw new Error("commit_sha must be a 40-char hex SHA");
      }
      commitSha = normalized;
    }

    let deployment;

    if (input.idempotencyKey) {
      const insertResult = await client.query(
        `
        INSERT INTO deployments (
          project_id,
          status,
          trigger,
          branch,
          commit_sha,
          idempotency_key,
          rollback_release_id,
          target_agent_id
        )
        VALUES ($1, 'queued', $2, $3, $5, $4, $6, $7)
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
          commitSha,
          input.rollbackReleaseId ?? null,
          targetAgentId,
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
          branch,
          commit_sha,
          rollback_release_id,
          target_agent_id
        )
        VALUES ($1, 'queued', $2, $3, $4, $5, $6)
        RETURNING *
        `,
        [
          input.projectId,
          input.trigger,
          project.branch,
          commitSha,
          input.rollbackReleaseId ?? null,
          targetAgentId,
        ]
      );

      deployment = insertResult.rows[0];
    }

    if (!deployment) throw new Error("Failed to create deployment");

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
      await recordDeploymentEvent(client, {
        deploymentId: deployment.id,
        eventType: "deployment.queued",
        statusFrom: null,
        statusTo: "queued",
        message: "Deployment queued",
        metadata: {
          trigger: deployment.trigger,
          branch: deployment.branch,
        },
      });
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

export async function transitionDeployment(
  deploymentId: string,
  to: DeploymentStatus,
  eventType: string,
  message: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT status FROM deployments WHERE id = $1 FOR UPDATE`,
      [deploymentId]
    );
    if (current.rowCount === 0) throw new Error("Deployment not found");
    const from = current.rows[0].status as DeploymentStatus;
    assertTransition(from, to);
    await client.query(
      `
      UPDATE deployments
      SET status = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [deploymentId, to]
    );
    await recordDeploymentEvent(client, {
      deploymentId,
      eventType,
      statusFrom: from,
      statusTo: to,
      message,
      metadata,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelDeployment(id: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT id, status FROM deployments WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const from = current.rows[0].status as DeploymentStatus;
    if (
      from === "active" ||
      from === "failed" ||
      from === "cancelled"
    ) {
      await client.query("ROLLBACK");
      throw new Error(
        `Cannot cancel deployment in status ${from}`
      );
    }
    assertTransition(from, "cancelled");
    await client.query(
      `
      UPDATE deployments
      SET status = 'cancelled',
          finished_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [id]
    );
    await client.query(
      `
      UPDATE deployment_jobs
      SET status = 'cancelled',
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          last_error = 'Cancelled by API request',
          updated_at = CURRENT_TIMESTAMP
      WHERE deployment_id = $1
        AND status IN ('queued', 'running')
      `,
      [id]
    );
    await recordDeploymentEvent(client, {
      deploymentId: id,
      eventType: "deployment.cancelled",
      statusFrom: from,
      statusTo: "cancelled",
      message: "Deployment cancelled by API request",
      metadata: {},
    });
    await client.query("COMMIT");
    return { id, status: "cancelled" };
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

export async function getDeploymentEvents(deploymentId: string) {
  const result = await pool.query(
    `
    SELECT id, deployment_id, event_type, status_from, status_to,
           message, metadata, created_at
    FROM deployment_events
    WHERE deployment_id = $1
    ORDER BY created_at ASC, id ASC
    `,
    [deploymentId]
  );
  return result.rows;
}
