// Phase 12.4: edge agent executor.
//
// Lifecycle (one deployment job, single pass):
//   1. Claim work through the existing machine-authenticated API.
//   2. Validate the returned job against the strict runtime schema
//      (edgeJobSchema.ts). Untrusted until parsed.
//   3. Reconcile via the heartbeat endpoint: confirm the lease is running
//      and owned by this agent before doing anything destructive.
//   4. Build an execution plan from server-provided data only
//      (planFromClaimedJob). The claim carries a trusted image block only
//      when the control plane resolved one from release/deployment records;
//      otherwise planning fails closed (EDGE_IMAGE_CONTRACT_MISSING) and
//      the run reports failure through the existing failure endpoint
//      without creating containers, without touching traffic, and never
//      reporting success.
//   5. Ready path (executeReadyPlan, exported for direct unit testing with
//      fakes): renew the lease throughout pull/start/health; pull the exact
//      digest-pinned image; create/start the container with the runtime
//      contract; pass bounded health checks; report success ONLY after
//      health passes; on phase failure stop/remove ONLY the owned container
//      and report failure with a bounded payload. A failed release never
//      disturbs the previously active container (different deployment
//      name/labels, never addressed).
//
// In production the ONLY producer of ready plans is planFromClaimedJob,
// which yields one exclusively from the validated trusted image block in
// the claim. executeReadyPlan is therefore reachable only when the server
// resolved a trustworthy reference; otherwise the run fails closed.
// Operator config can never inject an image: there is no plan input on
// runEdgeDeploymentOnce.
//
// Lease/cancellation/reconnect:
//   - Definitive lease loss (403/404/409), revocation (401), or ineligible
//     job state aborts execution; owned containers are cleaned up; no
//     completion/failure call is made for a lease we do not hold (the
//     server would reject it, and a blind call would be misleading).
//   - Transient network/timeout errors never count as rejection: reconcile
//     via heartbeat before retrying non-idempotent actions.
//   - AbortSignal cancels pull/start/health; cleanup still removes owned
//     containers so cancellation never leaves an untracked container.
//   - On reconnect the executor reconciles from server state + owned-label
//     listing and never blindly reruns: non-running jobs are not executed,
//     stale owned containers are removed before a fresh lifecycle, and
//     already-succeeded jobs converge via the idempotent completion
//     endpoint without recreating containers.
//
// Traffic safety: the executor never activates releases, never switches
// traffic, and never touches any gateway. Agent completion does not move
// the deployment to `active` under the current server contract (asserted by
// the existing "completion records success without faking activation"
// test), so there is deliberately no success path that implies serving
// traffic. See EDGE_ACTIVATION_UNSUPPORTED below.

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

// Reported when the control plane cannot yet supply a trusted image for an
// edge-targeted deployment. Today the claim response carries no image
// fields, so every real claim ends here: visible failure, no containers,
// no faked success. When the server contract grows image fields, extend
// planFromClaimedJob (field names must come from that server change —
// never guessed here).
export const EDGE_IMAGE_CONTRACT_MISSING = "EDGE_IMAGE_CONTRACT_MISSING";
// Documented limitation, not a runtime code: agent completion leaves the
// deployment non-active and no edge activation/rollback contract exists.
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
  // Resolved identity of THIS agent. Used only as a cross-check against the
  // server-leased job; server IDs are authoritative and always revalidated.
  agentId?: string;
}

export type EdgeExecutionPlan =
  | { kind: "blocked"; code: string; message: string }
  | { kind: "ready"; imageReference: string };

// Builds the execution plan from validated server data ONLY. A ready plan
// requires the trusted image block from the claim (AgentJobImage): the
// repository and digest are revalidated here, and only an immutable
// digest-pinned reference becomes executable. Without it there is no
// trusted source for what to pull, so planning fails closed with the exact
// missing upstream contract (no trusted release/deployment image record;
// central builds do not run for edge-targeted deployments).
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

  // Bounded overall run so a stuck phase cannot hold the process forever.
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
  // 1. Claim through the existing machine-authenticated API.
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

  // 2. Strict validation. On schema failure we cannot prove which job (if
  // any) the server leased us, so we touch nothing server-side (no
  // heartbeat/complete/fail without a validated job id) and create no
  // containers. The lease expires and server recovery requeues.
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
    // Agent linkage for the ownership gate comes from the server-leased job,
    // never from operator config alone (config is only a cross-check).
    agentId: job.agentId,
  };
  if (agentId !== undefined && agentId !== job.agentId) {
    // The server leased this job to a different agent id than we expect:
    // refuse to execute rather than act on a mismatched identity.
    return {
      result: "lease-lost",
      deploymentId: job.deploymentId,
      jobId: job.id,
      code: "EDGE_AGENT_MISMATCH",
    };
  }

  const cancelled = (): EdgeOutcome => ({ result: "cancelled", deploymentId: job.deploymentId, jobId: job.id });

  // 3. Reconcile: confirm the lease is running and owned by us before any
  // destructive or non-idempotent action.
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
    // Transient (including timeout): outcome unknown — report retryable and
    // let the caller reconcile again. Nothing created yet.
    return { result: "transient", code: "EDGE_RECONCILE_TRANSIENT", message: describe(error), deploymentId: job.deploymentId, jobId: job.id };
  }
  if (reconciled.job.id !== job.id || reconciled.job.deploymentId !== job.deploymentId) {
    await cleanupOwnedBestEffort(docker, identity);
    return { result: "lease-lost", deploymentId: job.deploymentId, jobId: job.id, code: "EDGE_STATE_MISMATCH" };
  }
  if (reconciled.job.status !== "running") {
    // Not ours to run (succeeded/cancelled/queued by someone else — e.g. a
    // reconnect after a timeout). Never rerun blindly: converge without
    // recreating containers. Server completion is idempotent for
    // already-succeeded jobs, so re-acknowledging is safe; for any other
    // non-running state just clean owned leftovers and stop.
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

  // 4. Execution plan from server data only. Fails closed today.
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
      // Transient on the failure report: the server may or may not have
      // recorded it. Reconcile (fresh heartbeat) before any retry — the
      // caller re-invokes runEdgeDeploymentOnce which re-runs reconciliation.
      return { result: "transient", code: "EDGE_REPORT_TRANSIENT", message: describe(error), deploymentId: job.deploymentId, jobId: job.id };
    }
    return { result: "blocked", deploymentId: job.deploymentId, jobId: job.id, code, message };
  }

  // 5. Ready path. Reached only when the claim carried a trusted image
  // block (planFromClaimedJob gates it); exercised directly in unit tests
  // with fakes.
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
        // Best-effort; ownership-gate refusals mean another agent's
        // container, which must be left alone.
      }
    }
  } catch {
    // Listing failure must never break the outcome path.
  }
}

export interface ReadyPlanDependencies {
  client: EdgeExecutorDependencies["client"];
  docker: EdgeExecutorDependencies["docker"];
  heartbeatIntervalMs?: number;
}

// Full pull -> start -> health -> complete lifecycle against the existing
// endpoints and Docker safety contract. Success is reported exclusively
// after waitHealthy resolves; every destructive step is ownership-gated;
// the previously active release's containers (other deployment names and
// labels) are never addressed.
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

  // Defense in depth: even a server-derived plan is revalidated here. Only
  // immutable digest references are pullable; anything else fails closed.
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

  // Remove stale owned containers from a previous crashed attempt before
  // starting a fresh lifecycle (proven-owned only; others are untouched).
  await cleanupOwnedBestEffort(docker, identity);
  if (callerSignal?.aborted || combinedSignal.aborted) return cancelled();

  // Lease watchdog: renew throughout pull/start/health. A definitive
  // rejection (revoked / not-owned / stale) or a non-running job state
  // aborts the phase work via phaseAbort. Transient heartbeat failures are
  // retried on the next tick — they never count as lease loss.
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
      // Transient: keep the previous lease view; retry next tick.
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
    // Final ownership proof immediately before the non-idempotent success
    // report: the lease may have been lost while health checks ran.
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
      // Transient on completion: the server may have recorded success. Do
      // not claim rejection — leave the healthy container in place and let
      // the caller reconcile (re-run converges via the idempotent
      // completion endpoint for succeeded jobs).
      return { result: "transient", code: "EDGE_REPORT_TRANSIENT", message: describe(error), deploymentId: job.deploymentId, jobId: job.id };
    }
    return { result: "succeeded", deploymentId: job.deploymentId, jobId: job.id };
  } catch (error) {
    stopBeats();
    await cleanupOwnedBestEffort(docker, identity);
    if (sawRevoked || isRevoked(error)) return { result: "revoked", code: "EDGE_AGENT_REVOKED" };
    if (callerSignal?.aborted) return cancelled();
    if (timeoutSignal.aborted) {
      // Internal execution timeout (not operator cancellation): reconcile
      // before reporting — only fail while we provably hold the lease.
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

// Reports a phase failure while (as far as we know) holding the lease, via
// the existing failure endpoint with a bounded payload. Reconciles first so
// a lost lease is never misreported as a phase failure.
async function reportPhaseFailure(
  client: EdgeExecutorDependencies["client"],
  job: ClaimedEdgeJob,
  combinedSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  code: string,
  message: string
): Promise<EdgeOutcome> {
  const leaseLost = (lostCode: string): EdgeOutcome => ({ result: "lease-lost", deploymentId: job.deploymentId, jobId: job.id, code: lostCode });
  // Ownership proof before the failure report.
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
