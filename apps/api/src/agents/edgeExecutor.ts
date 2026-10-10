

import type { EdgeAgentClient } from "./edgeAgentClient.js";
import {
  EdgeApiDefinitiveError,
  EdgeApiTransientError,
} from "./edgeAgentClient.js";
import type { EdgeDockerRuntime } from "./edgeDocker.js";
import { EdgeDockerError } from "./edgeDocker.js";
import {
  boundErrorCode,
  boundErrorMessage,
  EdgeJobSchemaError,
  parseClaimedJobResponse,
  parseHeartbeatState,
  parseImageReference,
  redactForLog,
  toImageReference,
  type ClaimedEdgeJob,
} from "./edgeJobSchema.js";

export const EDGE_IMAGE_CONTRACT_MISSING = "EDGE_IMAGE_CONTRACT_MISSING";

export const EDGE_ACTIVATION_UNSUPPORTED = "EDGE_ACTIVATION_UNSUPPORTED";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 600_000;

export type EdgeOutcome =
  | { result: "idle" }
  | { result: "succeeded"; deploymentId: string; jobId: string }
  | { result: "blocked"; deploymentId: string; jobId: string; code: string; message: string }
  | { result: "failed"; deploymentId: string; jobId: string; code: string; message: string }
  | { result: "lease-lost"; deploymentId: string | null; jobId: string | null; code: string }
  | { result: "revoked"; code: string }
  | { result: "cancelled"; deploymentId: string; jobId: string }
  | { result: "transient"; code: string; message: string; deploymentId: string | null; jobId: string | null };

export interface EdgeOwnedIdentity {
  deploymentId: string;
  projectId: string;
  agentId: string;
}

export interface EdgeExecutorDependencies {
  client: Pick<EdgeAgentClient, "claimJob" | "heartbeatJob" | "completeJob" | "failJob">;
  docker: Pick<EdgeDockerRuntime, "pullImage" | "createAndStart" | "waitHealthy" | "stopAndRemoveOwned" | "listOwnedContainers">;
  heartbeatIntervalMs?: number;
  executionTimeoutMs?: number;

  agentId?: string;
}

export type EdgeExecutionPlan =
  | { kind: "blocked"; code: string; message: string }
  | { kind: "ready"; imageReference: string };

export function planFromClaimedJob(job: ClaimedEdgeJob): EdgeExecutionPlan {
  if (job.image === null) {
    return {
      kind: "blocked",
      code: EDGE_IMAGE_CONTRACT_MISSING,
      message:
        "Control plane supplied no trusted digest-pinned image for this edge deployment " +
        "(no usable own-release row, rollback target, or validated deployment image columns). " +
        "Refusing to execute: no container created, no traffic touched. " +
        `Activation contract missing (${EDGE_ACTIVATION_UNSUPPORTED}).`,
    };
  }
  const parsed = parseImageReference(`${job.image.repository}@${job.image.digest}`);
  return {
    kind: "ready",
    imageReference: toImageReference(parsed),
  };
}

function heartbeatInterval(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(ms) || ms < 1_000 || ms > 60_000) {
    throw new Error("heartbeatIntervalMs must be 1000..60000 ms");
  }
  return ms;
}

function executionTimeout(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_EXECUTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(ms) || ms < 30_000 || ms > 3_600_000) {
    throw new Error("executionTimeoutMs must be 30000..3600000 ms");
  }
  return ms;
}

function isRevoked(error: unknown): boolean {
  return (
    error instanceof EdgeApiDefinitiveError &&
    (error.status === 401 || error.code === "EDGE_AGENT_UNAUTHORIZED")
  );
}

function isLeaseDefinitive(error: unknown): boolean {
  return (
    error instanceof EdgeApiDefinitiveError &&
    (error.status === 403 || error.status === 404 || error.status === 409)
  );
}

function describe(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactForLog(raw).slice(0, 500);
}

export async function runEdgeDeploymentOnce(
  deps: EdgeExecutorDependencies,
  signal?: AbortSignal
): Promise<EdgeOutcome> {
  const beatMs = heartbeatInterval(deps.heartbeatIntervalMs);
  const timeoutMs = executionTimeout(deps.executionTimeoutMs);
  const { client, docker } = deps;

  if (signal?.aborted) {
    return { result: "transient", code: "EDGE_CANCELLED_BEFORE_CLAIM", message: "Cancelled before claim", deploymentId: null, jobId: null };
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combinedSignal: AbortSignal =
    signal === undefined ? timeoutController.signal : AbortSignal.any([signal, timeoutController.signal]);
  try {
    return await runOnce(client, docker, deps.agentId, beatMs, combinedSignal, signal, timeoutController.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function runOnce(
  client: EdgeExecutorDependencies["client"],
  docker: EdgeExecutorDependencies["docker"],
  agentId: string | undefined,
  beatMs: number,
  combinedSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal
): Promise<EdgeOutcome> {

  let claimBody: unknown;
  try {
    claimBody = await client.claimJob(combinedSignal);
  } catch (error) {
    if (callerSignal?.aborted || combinedSignal.aborted) {
      return { result: "transient", code: "EDGE_CANCELLED_BEFORE_CLAIM", message: "Cancelled before claim", deploymentId: null, jobId: null };
    }
    if (isRevoked(error)) return { result: "revoked", code: "EDGE_AGENT_REVOKED" };
    if (error instanceof EdgeApiTransientError) {
      return { result: "transient", code: error.code, message: describe(error), deploymentId: null, jobId: null };
    }
    return { result: "transient", code: "EDGE_CLAIM_FAILED", message: describe(error), deploymentId: null, jobId: null };
  }

  let job: ClaimedEdgeJob;
  try {
    const parsed = parseClaimedJobResponse(claimBody);
    if (parsed === null) return { result: "idle" };
    job = parsed;
  } catch (error) {
    const detail = error instanceof EdgeJobSchemaError ? error.message : describe(error);
    return {
      result: "transient",
      code: "EDGE_INVALID_CLAIM",
      message: `Claimed job failed strict validation (${redactForLog(detail).slice(0, 300)}); touched nothing, lease left to expire`,
      deploymentId: null,
      jobId: null,
    };
  }

  const identity: EdgeOwnedIdentity = {
    deploymentId: job.deploymentId,
    projectId: job.projectId,

    agentId: job.agentId,
  };
  if (agentId !== undefined && agentId !== job.agentId) {

    return {
      result: "lease-lost",
      deploymentId: job.deploymentId,
      jobId: job.id,
      code: "EDGE_AGENT_MISMATCH",
    };
  }

  const cancelled = (): EdgeOutcome => ({ result: "cancelled", deploymentId: job.deploymentId, jobId: job.id });

  let reconciled: { job: { id: string; deploymentId: string; status: string }; deployment: { status: string } };
  try {
    const raw = await client.heartbeatJob(job.id, combinedSignal);
    reconciled = parseHeartbeatState(raw);
  } catch (error) {
    if (callerSignal?.aborted || combinedSignal.aborted) return cancelled();
    if (isRevoked(error)) {
      await cleanupOwnedBestEffort(docker, identity);
      return { result: "revoked", code: "EDGE_AGENT_REVOKED" };
    }
    if (isLeaseDefinitive(error)) {
      await cleanupOwnedBestEffort(docker, identity);
      return { result: "lease-lost", deploymentId: job.deploymentId, jobId: job.id, code: "EDGE_LEASE_STALE" };
    }

    return { result: "transient", code: "EDGE_RECONCILE_TRANSIENT", message: describe(error), deploymentId: job.deploymentId, jobId: job.id };
  }
  if (reconciled.job.id !== job.id || reconciled.job.deploymentId !== job.deploymentId) {
    await cleanupOwnedBestEffort(docker, identity);
    return { result: "lease-lost", deploymentId: job.deploymentId, jobId: job.id, code: "EDGE_STATE_MISMATCH" };
  }
  if (reconciled.job.status !== "running") {

    if (reconciled.job.status === "succeeded") {
      try {
        await client.completeJob(job.id, {}, combinedSignal);
        return { result: "succeeded", deploymentId: job.deploymentId, jobId: job.id };
      } catch (error) {
        if (isRevoked(error)) return { result: "revoked", code: "EDGE_AGENT_REVOKED" };
        if (isLeaseDefinitive(error)) {
          return { result: "lease-lost", deploymentId: job.deploymentId, jobId: job.id, code: "EDGE_LEASE_STALE" };
        }
        return { result: "transient", code: "EDGE_RECONCILE_TRANSIENT", message: describe(error), deploymentId: job.deploymentId, jobId: job.id };
      }
    }
    await cleanupOwnedBestEffort(docker, identity);
    return { result: "lease-lost", deploymentId: job.deploymentId, jobId: job.id, code: "EDGE_JOB_NOT_RUNNING" };
  }
  if (reconciled.deployment.status === "cancelled") {
    await cleanupOwnedBestEffort(docker, identity);
    return cancelled();
  }

  const plan = planFromClaimedJob(job);
  if (plan.kind === "blocked") {
    const code = boundErrorCode(plan.code, "EDGE_BLOCKED");
    const message = boundErrorMessage(plan.message, "Edge execution blocked: missing trusted image contract");
    try {
      await client.failJob(job.id, code, message, combinedSignal);
    } catch (error) {
      if (callerSignal?.aborted || combinedSignal.aborted) return cancelled();
      if (isRevoked(error)) return { result: "revoked", code: "EDGE_AGENT_REVOKED" };
      if (isLeaseDefinitive(error)) {
        return { result: "lease-lost", deploymentId: job.deploymentId, jobId: job.id, code: "EDGE_LEASE_STALE" };
      }

      return { result: "transient", code: "EDGE_REPORT_TRANSIENT", message: describe(error), deploymentId: job.deploymentId, jobId: job.id };
    }
    return { result: "blocked", deploymentId: job.deploymentId, jobId: job.id, code, message };
  }

  return executeReadyPlan(
    { client, docker, heartbeatIntervalMs: beatMs },
    job,
    identity,
    plan,
    combinedSignal,
    callerSignal,
    timeoutSignal
  );
}

async function cleanupOwnedBestEffort(
  docker: EdgeExecutorDependencies["docker"],
  identity: EdgeOwnedIdentity
): Promise<void> {
  try {
    const names = await docker.listOwnedContainers(identity.deploymentId);
    for (const name of names) {
      try {
        await docker.stopAndRemoveOwned(name, identity);
      } catch {
      }
    }
  } catch {
  }
}

export interface ReadyPlanDependencies {
  client: EdgeExecutorDependencies["client"];
  docker: EdgeExecutorDependencies["docker"];
  heartbeatIntervalMs?: number;
}

export async function executeReadyPlan(
  deps: ReadyPlanDependencies,
  job: ClaimedEdgeJob,
  identity: EdgeOwnedIdentity,
  plan: { kind: "ready"; imageReference: string },
  combinedSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal
): Promise<EdgeOutcome> {
  const { client, docker } = deps;
  const beatMs = heartbeatInterval(deps.heartbeatIntervalMs);

  let pinned: string;
  let digest: string;
  try {
    const parsed = parseImageReference(plan.imageReference);
    pinned = toImageReference(parsed);
    digest = parsed.digest;
  } catch (error) {
    const code = boundErrorCode("EDGE_INVALID_IMAGE", "EDGE_INVALID_IMAGE");
    const message = boundErrorMessage(
      error instanceof Error ? error.message : "Invalid image reference",
      "Invalid execution image"
    );
    return reportPhaseFailure(client, job, combinedSignal, callerSignal, code, message);
  }

  const cancelled = (): EdgeOutcome => ({ result: "cancelled", deploymentId: job.deploymentId, jobId: job.id });
  const leaseLost = (code: string): EdgeOutcome => ({ result: "lease-lost", deploymentId: job.deploymentId, jobId: job.id, code });

  await cleanupOwnedBestEffort(docker, identity);
  if (callerSignal?.aborted || combinedSignal.aborted) return cancelled();

  const phaseController = new AbortController();
  const phaseSignal = callerSignal === undefined
    ? AbortSignal.any([combinedSignal, phaseController.signal])
    : AbortSignal.any([callerSignal, combinedSignal, phaseController.signal]);
  let leaseAlive = true;
  let sawRevoked = false;
  const beat = async (): Promise<void> => {
    try {
      const raw = await client.heartbeatJob(job.id, combinedSignal);
      const state = parseHeartbeatState(raw);
      if (state.job.id !== job.id || state.job.status !== "running") {
        leaseAlive = false;
        phaseController.abort();
      }
    } catch (error) {
      if (isRevoked(error)) {
        sawRevoked = true;
        leaseAlive = false;
        phaseController.abort();
      } else if (isLeaseDefinitive(error)) {
        leaseAlive = false;
        phaseController.abort();
      }
    }
  };
  const timer = setInterval(() => { void beat(); }, beatMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
  const stopBeats = (): void => clearInterval(timer);

  try {
    await docker.pullImage(pinned, phaseSignal);
    if (phaseController.signal.aborted || combinedSignal.aborted) {
      throw phaseOutcomeError();
    }
    const runtime = await docker.createAndStart(identity, pinned, phaseSignal);
    try {
      await docker.waitHealthy(runtime, phaseSignal);
    } catch (error) {
      throw error;
    }
    if (phaseController.signal.aborted || combinedSignal.aborted) {
      throw phaseOutcomeError();
    }
    stopBeats();

    try {
      const raw = await client.heartbeatJob(job.id, combinedSignal);
      const state = parseHeartbeatState(raw);
      if (state.job.id !== job.id || state.job.status !== "running") {
        await cleanupOwnedBestEffort(docker, identity);
        return leaseLost("EDGE_LEASE_STALE");
      }
    } catch (error) {
      await cleanupOwnedBestEffort(docker, identity);
      if (callerSignal?.aborted || combinedSignal.aborted) return cancelled();
      if (isRevoked(error)) return { result: "revoked", code: "EDGE_AGENT_REVOKED" };
      if (isLeaseDefinitive(error)) return leaseLost("EDGE_LEASE_STALE");
      return { result: "transient", code: "EDGE_REPORT_TRANSIENT", message: describe(error), deploymentId: job.deploymentId, jobId: job.id };
    }
    if (callerSignal?.aborted || combinedSignal.aborted) {
      await cleanupOwnedBestEffort(docker, identity);
      return cancelled();
    }
    try {
      await client.completeJob(
        job.id,
        { imageDigest: digest, ...(job.commitSha !== null ? { commitSha: job.commitSha } : {}) },
        combinedSignal
      );
    } catch (error) {
      if (isRevoked(error)) {
        await cleanupOwnedBestEffort(docker, identity);
        return { result: "revoked", code: "EDGE_AGENT_REVOKED" };
      }
      if (isLeaseDefinitive(error)) {
        await cleanupOwnedBestEffort(docker, identity);
        return leaseLost("EDGE_LEASE_STALE");
      }

      return { result: "transient", code: "EDGE_REPORT_TRANSIENT", message: describe(error), deploymentId: job.deploymentId, jobId: job.id };
    }
    return { result: "succeeded", deploymentId: job.deploymentId, jobId: job.id };
  } catch (error) {
    stopBeats();
    await cleanupOwnedBestEffort(docker, identity);
    if (sawRevoked || isRevoked(error)) return { result: "revoked", code: "EDGE_AGENT_REVOKED" };
    if (callerSignal?.aborted) return cancelled();
    if (timeoutSignal.aborted) {

      return reportPhaseFailure(client, job, combinedSignal, callerSignal, "EDGE_EXECUTION_TIMEOUT", "Edge execution exceeded its bounded timeout");
    }
    if (!leaseAlive || isLeaseDefinitive(error) || isLeaseLostDocker(error)) {
      return leaseLost("EDGE_LEASE_STALE");
    }
    if (combinedSignal.aborted) return cancelled();
    const code = boundErrorCode(
      error instanceof EdgeDockerError ? error.code : "EDGE_EXECUTION_FAILED",
      "EDGE_EXECUTION_FAILED"
    );
    const message = boundErrorMessage(describe(error), "Edge execution failed");
    return reportPhaseFailure(client, job, combinedSignal, callerSignal, code, message);
  }
}

function phaseOutcomeError(): EdgeDockerError {
  return new EdgeDockerError("EDGE_PHASE_ABORTED", "Phase aborted after lease or cancellation signal");
}

function isLeaseLostDocker(error: unknown): boolean {
  return error instanceof EdgeDockerError && error.code === "EDGE_PHASE_ABORTED";
}

async function reportPhaseFailure(
  client: EdgeExecutorDependencies["client"],
  job: ClaimedEdgeJob,
  combinedSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  code: string,
  message: string
): Promise<EdgeOutcome> {
  const leaseLost = (lostCode: string): EdgeOutcome => ({ result: "lease-lost", deploymentId: job.deploymentId, jobId: job.id, code: lostCode });

  try {
    const raw = await client.heartbeatJob(job.id, combinedSignal);
    const state = parseHeartbeatState(raw);
    if (state.job.id !== job.id || state.job.status !== "running") {
      return leaseLost("EDGE_LEASE_STALE");
    }
  } catch (error) {
    if (callerSignal?.aborted || combinedSignal.aborted) {
      return { result: "cancelled", deploymentId: job.deploymentId, jobId: job.id };
    }
    if (error instanceof EdgeApiDefinitiveError && error.status === 401) {
      return { result: "revoked", code: "EDGE_AGENT_REVOKED" };
    }
    if (isLeaseDefinitive(error)) return leaseLost("EDGE_LEASE_STALE");
    return { result: "transient", code: "EDGE_REPORT_TRANSIENT", message: `Failure report deferred (reconcile first): ${describe(error).slice(0, 200)}`, deploymentId: job.deploymentId, jobId: job.id };
  }
  if (callerSignal?.aborted || combinedSignal.aborted) {
    return { result: "cancelled", deploymentId: job.deploymentId, jobId: job.id };
  }
  try {
    await client.failJob(job.id, boundErrorCode(code, "EDGE_EXECUTION_FAILED"), boundErrorMessage(message, "Edge execution failed"), combinedSignal);
  } catch (error) {
    if (callerSignal?.aborted || combinedSignal.aborted) {
      return { result: "cancelled", deploymentId: job.deploymentId, jobId: job.id };
    }
    if (error instanceof EdgeApiDefinitiveError && error.status === 401) {
      return { result: "revoked", code: "EDGE_AGENT_REVOKED" };
    }
    if (isLeaseDefinitive(error)) return leaseLost("EDGE_LEASE_STALE");
    return { result: "transient", code: "EDGE_REPORT_TRANSIENT", message: describe(error), deploymentId: job.deploymentId, jobId: job.id };
  }
  return { result: "failed", deploymentId: job.deploymentId, jobId: job.id, code: boundErrorCode(code, "EDGE_EXECUTION_FAILED"), message: boundErrorMessage(message, "Edge execution failed") };
}
