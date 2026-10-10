import pool from "../db/database.js";
import { withTransaction } from "../db/transaction.js";
import type { DeploymentStatus } from "../deployments/deploymentStateMachine.js";
import { recordDeploymentEvent } from "../deployments/deploymentEvents.js";
import { DIGEST_PATTERN } from "../services/releaseService.js";
import { validateRegistryRepository } from "../infrastructure/registry/registryConfig.js";
import {
  DEFAULT_LEASE_MS,
  extendJobLease,
  failJob,
} from "../workers/deploymentQueue.js";
import { getAgentById } from "./agentService.js";

export class AgentJobError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AgentJobError";
    this.code = code;
    this.status = status;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaimedAgentJob {
  id: string;
  deploymentId: string;
  projectId: string;
  agentId: string;
  attempts: number;
  maxAttempts: number;
  leaseExpiresAt: string | null;
  branch: string;
  commitSha: string | null;

  image: AgentJobImage | null;
}

export interface AgentJobImage {
  repository: string;
  digest: string;
  releaseId: string | null;
}

export interface AgentJobState {
  job: {
    id: string;
    deploymentId: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    leaseExpiresAt: string | null;
  };
  deployment: {
    id: string;
    status: string;
  };
}

export type AgentJobOutcome = "succeeded" | "failed";

export interface AgentJobCompletion {
  jobId: string;
  deploymentId: string;
  outcome: AgentJobOutcome;
  result: "completed" | "retrying" | "failed";
  jobStatus: string;
  deploymentStatus: string;
}

export interface AgentCompletionInput {
  outcome: AgentJobOutcome;
  imageDigest?: string | null;
  commitSha?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface AgentFailureInput {
  errorCode?: string | null;
  errorMessage: string;
}

interface OwnedJob {
  jobId: string;
  deploymentId: string;
  attempts: number;
  maxAttempts: number;
  jobStatus: string;
  lockedBy: string | null;
  deploymentStatus: DeploymentStatus;
  branch: string;
  commitSha: string | null;
}

function validateId(id: unknown, code: string): string {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw new AgentJobError(code, "Invalid id");
  }
  return id;
}

interface DbQuery {
  query(
    queryText: string,
    values?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

function toTrustedImage(
  repository: unknown,
  digest: unknown,
  releaseId: unknown
): AgentJobImage | null {
  if (typeof repository !== "string" || typeof digest !== "string") {
    return null;
  }
  let repo: string;
  try {

    repo = validateRegistryRepository(repository);
  } catch {
    return null;
  }
  if (!isRegistryQualified(repo)) {
    return null;
  }
  const normalizedDigest = digest.trim().toLowerCase();
  if (!DIGEST_PATTERN.test(normalizedDigest)) {
    return null;
  }
  return {
    repository: repo,
    digest: normalizedDigest,
    releaseId: typeof releaseId === "string" && UUID_PATTERN.test(releaseId) ? releaseId : null,
  };
}

function isRegistryQualified(repository: string): boolean {
  const host = repository.split("/")[0].toLowerCase();
  return host === "localhost" || host.includes(".") || host.includes(":");
}

export async function resolveTrustedJobImage(
  db: DbQuery,
  deploymentId: string,
  projectId: string
): Promise<AgentJobImage | null> {
  const dep = (
    await db.query(
      `
      SELECT project_id, trigger, image_repository, image_digest,
             release_id, rollback_release_id
      FROM deployments
      WHERE id = $1
      `,
      [deploymentId]
    )
  ).rows[0] as
    | {
        project_id: string;
        trigger: string;
        image_repository: string | null;
        image_digest: string | null;
        release_id: string | null;
        rollback_release_id: string | null;
      }
    | undefined;
  if (dep === undefined || dep.project_id !== projectId) {
    return null;
  }

  const ownRelease = (
    await db.query(
      `
      SELECT id, project_id, image_repository, image_digest, status
      FROM releases
      WHERE deployment_id = $1
      `,
      [deploymentId]
    )
  ).rows[0] as
    | {
        id: string;
        project_id: string;
        image_repository: string;
        image_digest: string;
        status: string;
      }
    | undefined;
  if (
    ownRelease !== undefined &&
    ownRelease.project_id === projectId &&
    ownRelease.status !== "failed"
  ) {
    const image = toTrustedImage(
      ownRelease.image_repository,
      ownRelease.image_digest,
      ownRelease.id
    );
    if (image !== null) {
      return image;
    }
  }

  if (dep.trigger === "rollback") {

    if (dep.rollback_release_id === null) {
      return null;
    }
    const target = (
      await db.query(
        `
        SELECT id, project_id, image_repository, image_digest, status
        FROM releases
        WHERE id = $1
        `,
        [dep.rollback_release_id]
      )
    ).rows[0] as
      | {
          id: string;
          project_id: string;
          image_repository: string;
          image_digest: string;
          status: string;
        }
      | undefined;
    if (
      target === undefined ||
      target.project_id !== projectId ||
      target.status === "failed"
    ) {
      return null;
    }
    return toTrustedImage(target.image_repository, target.image_digest, target.id);
  }

  return toTrustedImage(dep.image_repository, dep.image_digest, dep.release_id);
}

async function requireLiveAgent(agentId: string) {
  const agent = await getAgentById(validateId(agentId, "INVALID_AGENT"));
  if (!agent) {
    throw new AgentJobError("AGENT_NOT_FOUND", "Agent not found", 404);
  }
  if (agent.status === "revoked") {
    throw new AgentJobError("AGENT_REVOKED", "Agent is revoked", 403);
  }
  return agent;
}

async function loadOwnedJob(
  agentId: string,
  projectId: string,
  jobId: string
): Promise<OwnedJob> {
  const validJob = validateId(jobId, "INVALID_JOB");
  const row = (
    await pool.query(
      `
      SELECT j.id, j.deployment_id, j.status AS job_status,
             j.attempts, j.max_attempts,
             j.claimed_agent_id, j.locked_by,
             d.project_id, d.status AS deployment_status,
             d.branch, d.commit_sha
      FROM deployment_jobs j
      JOIN deployments d ON d.id = j.deployment_id
      WHERE j.id = $1
      `,
      [validJob]
    )
  ).rows[0] as
    | {
        id: string;
        deployment_id: string;
        job_status: string;
        attempts: number;
        max_attempts: number;
        claimed_agent_id: string | null;
        locked_by: string | null;
        project_id: string;
        deployment_status: DeploymentStatus;
        branch: string;
        commit_sha: string | null;
      }
    | undefined;
  if (row === undefined) {
    throw new AgentJobError("JOB_NOT_FOUND", "Job not found", 404);
  }
  if (row.project_id !== projectId) {
    throw new AgentJobError(
      "LEASE_NOT_OWNED",
      "Job belongs to another project",
      403
    );
  }
  if (row.claimed_agent_id !== agentId) {
    throw new AgentJobError(
      "LEASE_NOT_OWNED",
      "Job is not leased to this agent",
      403
    );
  }
  return {
    jobId: row.id,
    deploymentId: row.deployment_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    jobStatus: row.job_status,
    lockedBy: row.locked_by,
    deploymentStatus: row.deployment_status,
    branch: row.branch,
    commitSha: row.commit_sha,
  };
}

function requireRunningLease(owned: OwnedJob, agentId: string): void {
  if (owned.jobStatus !== "running" || owned.lockedBy !== agentId) {
    throw new AgentJobError("LEASE_STALE", "Job lease is no longer active", 409);
  }
}

async function readJobState(jobId: string): Promise<AgentJobState> {
  const row = (
    await pool.query(
      `
      SELECT j.id, j.deployment_id, j.status, j.attempts, j.max_attempts,
             j.lease_expires_at,
             d.status AS deployment_status
      FROM deployment_jobs j
      JOIN deployments d ON d.id = j.deployment_id
      WHERE j.id = $1
      `,
      [jobId]
    )
  ).rows[0] as {
    id: string;
    deployment_id: string;
    status: string;
    attempts: number;
    max_attempts: number;
    lease_expires_at: string | null;
    deployment_status: string;
  };
  return {
    job: {
      id: row.id,
      deploymentId: row.deployment_id,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      leaseExpiresAt: row.lease_expires_at,
    },
    deployment: { id: row.deployment_id, status: row.deployment_status },
  };
}

async function claimAgentJobAttempt(
  client: import("pg").PoolClient,
  agentId: string,
  projectId: string,
  leaseMs: number
): Promise<ClaimedAgentJob | null> {
  try {
    await client.query("BEGIN");

    const agent = (
      await client.query(`SELECT status FROM agents WHERE id = $1`, [agentId])
    ).rows[0] as { status: string } | undefined;
    if (agent === undefined) {
      throw new AgentJobError("AGENT_NOT_FOUND", "Agent not found", 404);
    }
    if (agent.status === "revoked") {
      throw new AgentJobError("AGENT_REVOKED", "Agent is revoked", 403);
    }

    const result = await client.query(
      `
      SELECT j.id, j.deployment_id, j.attempts, j.max_attempts
      FROM deployment_jobs j
      JOIN deployments d ON d.id = j.deployment_id
      WHERE d.target_agent_id = $1
        AND d.project_id = $2
        AND (
          (
            j.status = 'queued'
            AND j.available_at <= CURRENT_TIMESTAMP
            AND j.attempts < j.max_attempts
          )
          OR
          (
            j.status = 'running'
            AND j.lease_expires_at IS NOT NULL
            AND j.lease_expires_at <= CURRENT_TIMESTAMP
            AND j.attempts < j.max_attempts
          )
        )
      ORDER BY j.created_at ASC
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1
      `,
      [agentId, projectId]
    );

    if (result.rows.length === 0) {
      await client.query("COMMIT");
      return null;
    }

    const job = result.rows[0];

    const updated = (
      await client.query(
        `
        UPDATE deployment_jobs
        SET status = 'running',
            attempts = attempts + 1,
            locked_at = CURRENT_TIMESTAMP,
            locked_by = $2,
            lease_expires_at =
              CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond'),
            claimed_agent_id = $4,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING id, deployment_id, attempts, max_attempts,
                  lease_expires_at
        `,
        [job.id, agentId, leaseMs, agentId]
      )
    ).rows[0] as {
      id: string;
      deployment_id: string;
      attempts: number;
      max_attempts: number;
      lease_expires_at: string | null;
    };

    const deployment = (
      await client.query(
        `
        SELECT status, branch, commit_sha
        FROM deployments
        WHERE id = $1
        FOR UPDATE
        `,
        [updated.deployment_id]
      )
    ).rows[0] as {
      status: string;
      branch: string;
      commit_sha: string | null;
    };

    const image = await resolveTrustedJobImage(
      client,
      updated.deployment_id,
      projectId
    );

    const previousStatus = deployment.status;
    const nextStatus = previousStatus === "queued" ? "cloning" : previousStatus;
    if (nextStatus !== previousStatus) {
      await client.query(
        `
        UPDATE deployments
        SET status = 'cloning',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [updated.deployment_id]
      );
    } else {
      await client.query(
        `
        UPDATE deployments
        SET started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [updated.deployment_id]
      );
    }

    await client.query(
      `
      INSERT INTO deployment_attempts (
        deployment_id, attempt_number, status, worker_id, started_at
      )
      VALUES ($1, $2, 'cloning', $3, CURRENT_TIMESTAMP)
      ON CONFLICT (deployment_id, attempt_number)
      DO UPDATE SET status = EXCLUDED.status,
                    worker_id = EXCLUDED.worker_id,
                    started_at = CURRENT_TIMESTAMP
      `,
      [updated.deployment_id, updated.attempts, agentId]
    );

    await client.query(
      `
      INSERT INTO deployment_events (
        deployment_id, event_type, status_from, status_to, message, metadata
      )
      VALUES ($1, 'deployment.claimed', $2, $3, $4, $5::jsonb)
      `,
      [
        updated.deployment_id,
        previousStatus,
        nextStatus,
        "Deployment claimed by edge agent",
        JSON.stringify({
          agentId,
          attempt: updated.attempts,
          maxAttempts: updated.max_attempts,
          leaseMs,
        }),
      ]
    );

    await client.query("COMMIT");

    return {
      id: updated.id,
      deploymentId: updated.deployment_id,
      projectId,
      agentId,
      attempts: updated.attempts,
      maxAttempts: updated.max_attempts,
      leaseExpiresAt: updated.lease_expires_at,
      branch: deployment.branch,
      commitSha: deployment.commit_sha,
      image,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function claimAgentJob(
  agentId: string,
  leaseMs = DEFAULT_LEASE_MS
): Promise<ClaimedAgentJob | null> {
  const validAgent = validateId(agentId, "INVALID_AGENT");
  const agent = await getAgentById(validAgent);
  if (!agent) {
    throw new AgentJobError("AGENT_NOT_FOUND", "Agent not found", 404);
  }
  const client = await pool.connect();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await claimAgentJobAttempt(
          client,
          validAgent,
          agent.projectId,
          leaseMs
        );
      } catch (error) {
        if (
          attempt < 2 &&
          error instanceof Error &&
          "code" in error &&
          (error as { code?: string }).code === "40P01"
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, 50 * (attempt + 1))
          );
          continue;
        }
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

export async function heartbeatAgentJob(
  agentId: string,
  jobId: string,
  leaseMs = DEFAULT_LEASE_MS
): Promise<AgentJobState> {
  const validAgent = validateId(agentId, "INVALID_AGENT");
  const agent = await requireLiveAgent(validAgent);
  const owned = await loadOwnedJob(validAgent, agent.projectId, jobId);
  requireRunningLease(owned, validAgent);
  const extended = await extendJobLease(owned.jobId, validAgent, leaseMs);
  if (!extended) {
    throw new AgentJobError("LEASE_STALE", "Job lease is no longer active", 409);
  }
  return readJobState(owned.jobId);
}

async function reportAgentFailure(
  agentId: string,
  owned: OwnedJob,
  message: string
): Promise<AgentJobCompletion> {
  const result = await failJob(owned.jobId, owned.deploymentId, agentId, message);
  const state = await readJobState(owned.jobId);
  return {
    jobId: owned.jobId,
    deploymentId: owned.deploymentId,
    outcome: "failed",
    result,
    jobStatus: state.job.status,
    deploymentStatus: state.deployment.status,
  };
}

export async function completeAgentJob(
  agentId: string,
  jobId: string,
  input: AgentCompletionInput
): Promise<AgentJobCompletion> {
  const validAgent = validateId(agentId, "INVALID_AGENT");
  const agent = await requireLiveAgent(validAgent);
  const owned = await loadOwnedJob(validAgent, agent.projectId, jobId);
  if (owned.jobStatus === "succeeded") {
    const state = await readJobState(owned.jobId);
    return {
      jobId: owned.jobId,
      deploymentId: owned.deploymentId,
      outcome: "succeeded",
      result: "completed",
      jobStatus: state.job.status,
      deploymentStatus: state.deployment.status,
    };
  }
  if (owned.jobStatus !== "running") {
    throw new AgentJobError("LEASE_STALE", "Job lease is no longer active", 409);
  }
  requireRunningLease(owned, validAgent);
  if (input.outcome === "succeeded" && input.imageDigest != null) {

    const trusted = await resolveTrustedJobImage(
      pool,
      owned.deploymentId,
      agent.projectId
    );
    if (
      trusted !== null &&
      trusted.digest !== input.imageDigest.trim().toLowerCase()
    ) {
      throw new AgentJobError(
        "IMAGE_MISMATCH",
        "Reported image digest does not match the trusted deployment image",
        409
      );
    }
  }
  if (input.outcome === "failed") {
    const message =
      input.errorCode != null
        ? `${input.errorCode}: ${input.errorMessage ?? "Agent reported failure"}`
        : (input.errorMessage ?? "Agent reported failure");
    return reportAgentFailure(validAgent, owned, message);
  }
  return withTransaction(async (client) => {
    await recordDeploymentEvent(client, {
      deploymentId: owned.deploymentId,
      eventType: "deployment.agent_completed",
      statusFrom: owned.deploymentStatus,
      statusTo: owned.deploymentStatus,
      message: "Edge agent reported successful completion",
      metadata: {
        agentId: validAgent,
        attempt: owned.attempts,
        ...(input.imageDigest != null ? { imageDigest: input.imageDigest } : {}),
        ...(input.commitSha != null ? { commitSha: input.commitSha } : {}),
      },
    });
    await client.query(
      `
      UPDATE deployment_jobs
      SET status = 'succeeded',
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [owned.jobId]
    );
  }).then(async () => {
    const state = await readJobState(owned.jobId);
    return {
      jobId: owned.jobId,
      deploymentId: owned.deploymentId,
      outcome: "succeeded" as const,
      result: "completed" as const,
      jobStatus: state.job.status,
      deploymentStatus: state.deployment.status,
    };
  });
}

export async function failAgentJob(
  agentId: string,
  jobId: string,
  input: AgentFailureInput
): Promise<AgentJobCompletion> {
  const validAgent = validateId(agentId, "INVALID_AGENT");
  const agent = await requireLiveAgent(validAgent);
  const owned = await loadOwnedJob(validAgent, agent.projectId, jobId);
  requireRunningLease(owned, validAgent);
  const message =
    input.errorCode != null
      ? `${input.errorCode}: ${input.errorMessage}`
      : input.errorMessage;
  return reportAgentFailure(validAgent, owned, message);
}
