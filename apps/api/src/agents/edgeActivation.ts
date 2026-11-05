import type { Pool } from "pg";
import { markRelease, activateRelease } from "../services/releaseService.js";
import { recordDeploymentEvent } from "../deployments/deploymentEvents.js";
import type { DeploymentStatus } from "../deployments/deploymentStateMachine.js";
import { edgeContainerName } from "./edgeDocker.js";
import { AgentJobError } from "./agentJobErrors.js";

interface TrustedImage {
  repository?: string | null;
  digest?: string | null;
}

interface EdgeActivationInput {
  containerPort?: number | null;
  hostPort?: number | null;
}

interface OwnedJobRef {
  jobId: string;
  deploymentId: string;
  branch: string;
  commitSha: string | null;
}

interface DeploymentRow {
  trigger: string | null;
  rollbackReleaseId: string | null;
  commitSha: string | null;
}

/**
 * Creates and activates the release for a completed edge-agent execution and
 * records the agent-reported runtime descriptor.
 *
 * Engine invariants preserved:
 * - one release per deployment (ON CONFLICT (deployment_id)), so completion
 *   retries are idempotent and the one-active-release-per-project invariant
 *   still holds;
 * - the runtime row carries ip_address NULL as the edge marker — every
 *   central consumer of runtime_instances (route resolution, health monitor)
 *   skips rows without an IP, so edge containers are never wired into the
 *   central nginx gateway;
 * - the container name is derived server-side from the deployment identity
 *   and never taken from the agent.
 */
export async function activateEdgeDeployment(
  pool: Pool,
  projectId: string,
  owned: OwnedJobRef,
  trusted: TrustedImage,
  input: EdgeActivationInput
): Promise<void> {
  let repository: string | null = typeof trusted.repository === "string" && trusted.repository !== "" ? trusted.repository : null;
  let digest: string | null = typeof trusted.digest === "string" && trusted.digest !== "" ? trusted.digest : null;
  let rollbackReleaseId: string | null = null;

  const lookup = await pool.connect();
  let deployment: DeploymentRow | null = null;
  try {
    const result = await lookup.query(
      `
      SELECT trigger, rollback_release_id, commit_sha
      FROM deployments
      WHERE id = $1 AND project_id = $2
      `,
      [owned.deploymentId, projectId]
    );
    deployment = result.rows.length === 1
      ? {
          trigger: (result.rows[0].trigger ?? null) as string | null,
          rollbackReleaseId: (result.rows[0].rollback_release_id ?? null) as string | null,
          commitSha: (result.rows[0].commit_sha ?? null) as string | null,
        }
      : null;
  } finally {
    lookup.release();
  }
  if (deployment === null) {
    throw new AgentJobError("DEPLOYMENT_NOT_FOUND", "Deployment not found for edge activation", 409);
  }

  if (deployment.trigger === "rollback" && deployment.rollbackReleaseId !== null) {
    const target = await pool.connect();
    try {
      const row = await target.query(
        `
        SELECT image_repository, image_digest
        FROM releases
        WHERE id = $1 AND project_id = $2
        `,
        [deployment.rollbackReleaseId, projectId]
      );
      if (row.rows.length === 1) {
        repository = (row.rows[0].image_repository ?? null) as string | null;
        digest = (row.rows[0].image_digest ?? null) as string | null;
      }
    } finally {
      target.release();
    }
    rollbackReleaseId = deployment.rollbackReleaseId;
  }

  if (!repository || !digest) {
    throw new AgentJobError(
      "EDGE_IMAGE_CONTRACT_MISSING",
      "No trusted image contract for this edge deployment",
      409
    );
  }

  const commitSha = owned.commitSha ?? deployment.commitSha;

  // The active release at this moment is the one this activation supersedes;
  // activateRelease's per-project advisory lock serializes the swap itself.
  const previous = await pool.connect();
  let supersedesReleaseId: string | null = null;
  try {
    const activeRow = await previous.query(
      `
      SELECT id
      FROM releases
      WHERE project_id = $1 AND status = 'active'
      ORDER BY activated_at DESC NULLS LAST
      LIMIT 1
      `,
      [projectId]
    );
    supersedesReleaseId = activeRow.rows.length === 1 ? (activeRow.rows[0].id as string) : null;
  } finally {
    previous.release();
  }

  const releaseId = await ensureReleaseRow(pool, {
    deploymentId: owned.deploymentId,
    projectId,
    repository,
    digest,
    commitSha,
    branch: owned.branch,
    supersedesReleaseId,
  });

  // Releases enter as 'starting' from the edge insert; existing rows (created
  // earlier in the pipeline, e.g. as 'pending') are promoted along the legal
  // transitions to what activateRelease requires.
  await promoteReleaseToHealthy(pool, releaseId);

  await upsertEdgeRuntimeInstance(pool, releaseId, edgeContainerName(projectId, owned.deploymentId), input);

  await activateRelease(projectId, releaseId, owned.deploymentId, null);

  await markDeploymentActive(pool, owned.deploymentId, projectId, rollbackReleaseId);
}

async function ensureReleaseRow(
  pool: Pool,
  input: {
    deploymentId: string;
    projectId: string;
    repository: string;
    digest: string;
    commitSha: string | null;
    branch: string;
    supersedesReleaseId: string | null;
  }
): Promise<string> {
  const client = await pool.connect();
  try {
    const inserted = await client.query(
      `
      INSERT INTO releases (
        deployment_id, project_id, image_repository, image_digest,
        commit_sha, branch, status, supersedes_release_id, started_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,'starting',$7, CURRENT_TIMESTAMP)
      ON CONFLICT (deployment_id)
      DO NOTHING
      RETURNING id
      `,
      [
        input.deploymentId,
        input.projectId,
        input.repository,
        input.digest,
        typeof input.commitSha === "string" ? input.commitSha.toLowerCase() : null,
        input.branch,
        input.supersedesReleaseId,
      ]
    );
    if (inserted.rows.length === 1) {
      return inserted.rows[0].id as string;
    }
    const existing = await client.query(
      `SELECT id FROM releases WHERE deployment_id = $1`,
      [input.deploymentId]
    );
    if (existing.rows.length !== 1) {
      throw new AgentJobError("EDGE_ACTIVATION_CONFLICT", "Release insert conflict for edge activation", 409);
    }
    return existing.rows[0].id as string;
  } finally {
    client.release();
  }
}

async function promoteReleaseToHealthy(pool: Pool, releaseId: string): Promise<void> {
  const client = await pool.connect();
  let status: string;
  try {
    const row = await client.query(`SELECT status FROM releases WHERE id = $1`, [releaseId]);
    if (row.rows.length !== 1) {
      throw new AgentJobError("EDGE_ACTIVATION_CONFLICT", "Release row disappeared during edge activation", 409);
    }
    status = row.rows[0].status as string;
  } finally {
    client.release();
  }
  if (status === "healthy" || status === "active") {
    return;
  }
  if (status === "pending") {
    await markRelease(releaseId, "starting");
    await markRelease(releaseId, "healthy");
    return;
  }
  if (status === "starting") {
    await markRelease(releaseId, "healthy");
    return;
  }
  throw new AgentJobError(
    "EDGE_ACTIVATION_CONFLICT",
    `Release cannot be promoted from ${status} for edge activation`,
    409
  );
}

async function upsertEdgeRuntimeInstance(
  pool: Pool,
  releaseId: string,
  containerName: string,
  input: EdgeActivationInput
): Promise<void> {
  const containerPort = input.containerPort ?? null;
  if (containerPort === null || !Number.isSafeInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
    throw new AgentJobError("EDGE_INVALID_CONTAINER_PORT", "Agent must report a valid container port", 400);
  }
  const hostPort = input.hostPort ?? null;
  if (hostPort !== null && (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65535)) {
    throw new AgentJobError("EDGE_INVALID_HOST_PORT", "Invalid host port reported by agent", 400);
  }
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO runtime_instances (
        release_id, status, container_name, container_port, host_port, ip_address
      )
      VALUES ($1, 'running', $2, $3, $4, NULL)
      ON CONFLICT (container_name)
      DO UPDATE SET
        release_id = EXCLUDED.release_id,
        status = 'running',
        container_port = EXCLUDED.container_port,
        host_port = EXCLUDED.host_port
      `,
      [releaseId, containerName, containerPort, hostPort]
    );
  } finally {
    client.release();
  }
}

async function markDeploymentActive(
  pool: Pool,
  deploymentId: string,
  projectId: string,
  rollbackReleaseId: string | null
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `
      SELECT status FROM deployments
      WHERE id = $1 AND project_id = $2
      FOR UPDATE
      `,
      [deploymentId, projectId]
    );
    if (current.rows.length !== 1) {
      await client.query("COMMIT");
      return;
    }
    const statusFrom = current.rows[0].status as string;
    if (statusFrom === "failed" || statusFrom === "cancelled" || statusFrom === "active") {
      await client.query("COMMIT");
      return;
    }
    await client.query(
      `
      UPDATE deployments
      SET status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [deploymentId]
    );
    // Edge activations arrive out-of-band from the central pipeline, so the
    // FSM hops are collapsed into a single transition event; the metadata
    // records why.
    await recordDeploymentEvent(client, {
      deploymentId,
      eventType: "deployment.activated",
      statusFrom: statusFrom as DeploymentStatus,
      statusTo: "active" as DeploymentStatus,
      message: "Deployment activated by edge agent",
      metadata: {
        source: "edge_agent",
        ...(rollbackReleaseId !== null ? { rollbackReleaseId } : {}),
      },
    });
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection already unusable
    }
    throw error;
  } finally {
    client.release();
  }
}
