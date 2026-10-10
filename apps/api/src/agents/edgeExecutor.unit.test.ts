
import test from "node:test";
import assert from "node:assert/strict";

import {
  EdgeApiDefinitiveError,
  EdgeApiTransientError,
} from "./edgeAgentClient.js";
import { EdgeDockerError, edgeContainerName } from "./edgeDocker.js";
import {
  EDGE_IMAGE_CONTRACT_MISSING,
  executeReadyPlan,
  runEdgeDeploymentOnce,
  type EdgeOutcome,
} from "./edgeExecutor.js";
import type { ClaimedEdgeJob } from "./edgeJobSchema.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4434-8344-444444444444";
const OTHER_DEPLOYMENT = "55555555-5555-4555-8555-555555555555";
const GOOD_IMAGE = `registry.local:5000/deploykit/project-aaaaaaaa@sha256:${"c".repeat(64)}`;
const GOOD_DIGEST = `sha256:${"c".repeat(64)}`;
const OWN_NAME = edgeContainerName(PROJECT_ID, DEPLOYMENT_ID);
const PREVIOUS_NAME = edgeContainerName(PROJECT_ID, OTHER_DEPLOYMENT);

function job(): ClaimedEdgeJob {
  return {
    id: JOB_ID,
    deploymentId: DEPLOYMENT_ID,
    projectId: PROJECT_ID,
    agentId: AGENT_ID,
    attempts: 1,
    maxAttempts: 3,
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    branch: "main",
    commitSha: "b".repeat(40),
    image: null,
  };
}

function runningState() {
  return {
    job: { id: JOB_ID, deploymentId: DEPLOYMENT_ID, status: "running", attempts: 1, maxAttempts: 3, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() },
    deployment: { id: DEPLOYMENT_ID, status: "cloning" },
  };
}

interface ClientCalls { method: string; jobId?: string; payload?: unknown }
interface FakeClient {
  calls: ClientCalls[];
  claimImpl: () => unknown | Promise<unknown>;
  heartbeatImpl: () => unknown | Promise<unknown>;
  completeImpl: (payload: unknown) => unknown | Promise<unknown>;
  failImpl: (code: string, message: string) => unknown | Promise<unknown>;
  client: {
    claimJob(s?: AbortSignal): Promise<unknown>;
    heartbeatJob(j: string, s?: AbortSignal): Promise<unknown>;
    completeJob(j: string, p: unknown, s?: AbortSignal): Promise<unknown>;
    failJob(j: string, c: string, m: string, s?: AbortSignal): Promise<unknown>;
  };
}

function fakeClient(overrides: Partial<Pick<FakeClient, "claimImpl" | "heartbeatImpl" | "completeImpl" | "failImpl">> = {}): FakeClient {
  const fake: FakeClient = {
    calls: [],
    claimImpl: overrides.claimImpl ?? (() => ({ job: job() })),
    heartbeatImpl: overrides.heartbeatImpl ?? (() => runningState()),
    completeImpl: overrides.completeImpl ?? (() => ({ ok: true })),
    failImpl: overrides.failImpl ?? (() => ({ ok: true })),
    client: null as never,
  };
  fake.client = {
    claimJob: async () => fake.claimImpl(),
    heartbeatJob: async (j: string) => { fake.calls.push({ method: "heartbeat", jobId: j }); return fake.heartbeatImpl(); },
    completeJob: async (j: string, p: unknown) => { fake.calls.push({ method: "complete", jobId: j, payload: p }); return fake.completeImpl(p); },
    failJob: async (j: string, c: string, m: string) => { fake.calls.push({ method: "fail", jobId: j, payload: { errorCode: c, errorMessage: m } }); return fake.failImpl(c, m); },
  };
  return fake;
}

interface DockerCalls { method: string; arg?: unknown }
interface FakeDocker {
  calls: DockerCalls[];
  order: string[];
  pullImpl: () => Promise<string>;
  createImpl: () => Promise<{ containerName: string } & Record<string, unknown>>;
  healthyImpl: () => Promise<void>;
  docker: {
    pullImage(ref: string, s?: AbortSignal): Promise<string>;
    createAndStart(id: unknown, ref: string, s?: AbortSignal): Promise<never>;
    waitHealthy(rt: unknown, s?: AbortSignal): Promise<void>;
    stopAndRemoveOwned(name: string, id: unknown): Promise<void>;
    listOwnedContainers(dep: string): Promise<string[]>;
  };
  removed: string[];
  owned: string[];
}

function fakeDocker(overrides: Partial<Pick<FakeDocker, "pullImpl" | "createImpl" | "healthyImpl" | "owned">> = {}): FakeDocker {
  const fake: FakeDocker = {
    calls: [],
    order: [],
    removed: [],
    owned: overrides.owned ?? [],
    pullImpl: overrides.pullImpl ?? (async () => GOOD_IMAGE),
    createImpl: overrides.createImpl ?? (async () => ({ containerName: OWN_NAME, containerPort: 3000, ipAddress: "172.18.0.5", networkName: "deploykit-runtime", healthPath: "/", containerId: "d".repeat(64) })),
    healthyImpl: overrides.healthyImpl ?? (async () => undefined),
    docker: null as never,
  };
  fake.docker = {
    pullImage: async (ref: string) => { fake.calls.push({ method: "pull", arg: ref }); fake.order.push("pull"); return fake.pullImpl(); },
    createAndStart: (async (_id: unknown, _ref: string) => {
      fake.calls.push({ method: "create" }); fake.order.push("create");
      return fake.createImpl();
    }) as never,
    waitHealthy: async () => { fake.calls.push({ method: "healthy" }); fake.order.push("healthy"); return fake.healthyImpl(); },
    stopAndRemoveOwned: async (name: string) => { fake.calls.push({ method: "remove", arg: name }); fake.removed.push(name); },
    listOwnedContainers: async () => [...fake.owned],
  };
  return fake;
}

test("idle when no job is claimed; nothing touched", async () => {
  const client = fakeClient({ claimImpl: () => ({ job: null }) });
  const docker = fakeDocker();
  const outcome = await runEdgeDeploymentOnce({ client: client.client, docker: docker.docker as never });
  assert.equal(outcome.result, "idle");
  assert.deepEqual(docker.calls, []);
  assert.ok(!client.calls.some((c) => c.method === "fail" || c.method === "complete"));
});

test("blocked contract: reports bounded failure, creates nothing, never succeeds", async () => {
  const client = fakeClient();
  const docker = fakeDocker();
  const outcome = await runEdgeDeploymentOnce({ client: client.client, docker: docker.docker as never });
  assert.equal(outcome.result, "blocked");
  assert.equal((outcome as { code: string }).code, EDGE_IMAGE_CONTRACT_MISSING);

  const fail = client.calls.find((c) => c.method === "fail");
  assert.ok(fail, "expected a failure report");
  const payload = fail.payload as { errorCode: string; errorMessage: string };
  assert.equal(payload.errorCode, EDGE_IMAGE_CONTRACT_MISSING);
  assert.ok(payload.errorMessage.length >= 1 && payload.errorMessage.length <= 4000);

  assert.deepEqual(docker.calls, []);
  assert.ok(!client.calls.some((c) => c.method === "complete"));
});

test("invalid claim shape touches nothing (no calls without a proven job id)", async () => {
  const client = fakeClient({ claimImpl: () => ({ job: { id: "bogus", deploymentId: 42 } }) });
  const docker = fakeDocker();
  const outcome = await runEdgeDeploymentOnce({ client: client.client, docker: docker.docker as never });
  assert.equal(outcome.result, "transient");
  assert.equal((outcome as { code: string }).code, "EDGE_INVALID_CLAIM");
  assert.deepEqual(client.calls, [], "no heartbeat/complete/fail without validated ids");
  assert.deepEqual(docker.calls, []);
});

test("agent identity mismatch refuses to execute", async () => {
  const client = fakeClient();
  const docker = fakeDocker();
  const outcome = await runEdgeDeploymentOnce({
    client: client.client,
    docker: docker.docker as never,
    agentId: "99999999-9999-4999-8999-999999999999",
  });
  assert.equal(outcome.result, "lease-lost");
  assert.deepEqual(docker.calls, []);
  assert.ok(!client.calls.some((c) => c.method === "fail" || c.method === "complete"));
});

test("definitive lease loss cleans owned containers and never reports", async () => {
  const client = fakeClient({
    heartbeatImpl: () => { throw new EdgeApiDefinitiveError("EDGE_LEASE_STALE", "stale", 409); },
  });
  const docker = fakeDocker({ owned: [OWN_NAME] });
  const outcome = await runEdgeDeploymentOnce({ client: client.client, docker: docker.docker as never });
  assert.equal(outcome.result, "lease-lost");
  assert.deepEqual(docker.removed, [OWN_NAME]);
  assert.ok(!client.calls.some((c) => c.method === "fail" || c.method === "complete")), "no blind reports for a lost lease";
});

test("revoked agent stops without reporting", async () => {
  const client = fakeClient({
    heartbeatImpl: () => { throw new EdgeApiDefinitiveError("EDGE_AGENT_UNAUTHORIZED", "revoked", 401); },
  });
  const docker = fakeDocker();
  const outcome = await runEdgeDeploymentOnce({ client: client.client, docker: docker.docker as never });
  assert.equal(outcome.result, "revoked");
  assert.ok(!client.calls.some((c) => c.method === "fail" || c.method === "complete"));
});

test("transient reconcile failure is retryable and creates nothing", async () => {
  const client = fakeClient({
    heartbeatImpl: () => { throw new EdgeApiTransientError("timeout; outcome unknown"); },
  });
  const docker = fakeDocker();
  const outcome = await runEdgeDeploymentOnce({ client: client.client, docker: docker.docker as never });
  assert.equal(outcome.result, "transient");
  assert.deepEqual(docker.calls, []);
});

test("non-running job is never rerun; succeeded converges idempotently", async () => {
  const queued = fakeClient({
    heartbeatImpl: () => ({ job: { ...runningState().job, status: "queued" }, deployment: { id: DEPLOYMENT_ID, status: "queued" } }),
  });
  const docker = fakeDocker();
  const outcome = await runEdgeDeploymentOnce({ client: queued.client, docker: docker.docker as never });
  assert.equal(outcome.result, "lease-lost");
  assert.deepEqual(docker.calls, [], "no containers for a non-running job");

  const succeeded = fakeClient({
    heartbeatImpl: () => ({ job: { ...runningState().job, status: "succeeded" }, deployment: { id: DEPLOYMENT_ID, status: "cloning" } }),
  });
  const docker2 = fakeDocker();
  const outcome2 = await runEdgeDeploymentOnce({ client: succeeded.client, docker: docker2.docker as never });
  assert.equal(outcome2.result, "succeeded");
  assert.equal(succeeded.calls.filter((c) => c.method === "complete").length, 1);
  assert.deepEqual(docker2.calls, [], "converge without recreating containers");
});

test("cancelled deployment converges to cancelled with owned cleanup", async () => {
  const client = fakeClient({
    heartbeatImpl: () => ({ job: runningState().job, deployment: { id: DEPLOYMENT_ID, status: "cancelled" } }),
  });
  const docker = fakeDocker({ owned: [OWN_NAME] });
  const outcome = await runEdgeDeploymentOnce({ client: client.client, docker: docker.docker as never });
  assert.equal(outcome.result, "cancelled");
  assert.deepEqual(docker.removed, [OWN_NAME]);
  assert.ok(!client.calls.some((c) => c.method === "fail" || c.method === "complete"));
});

test("ready path success: lease renewed during ops, success only after health", async () => {
  const client = fakeClient();
  const docker = fakeDocker({
    healthyImpl: async () => { await new Promise((r) => setTimeout(r, 1200)); },
  });
  const outcome = await executeReadyPlan(
    { client: client.client, docker: docker.docker as never, heartbeatIntervalMs: 1000 },
    job(),
    { deploymentId: DEPLOYMENT_ID, projectId: PROJECT_ID, agentId: AGENT_ID },
    { kind: "ready", imageReference: GOOD_IMAGE },
    AbortSignal.timeout(30_000),
    undefined,
    AbortSignal.timeout(60_000)
  );
  assert.equal(outcome.result, "succeeded");

  const beats = client.calls.filter((c) => c.method === "heartbeat").length;
  assert.ok(beats >= 2, `expected lease renewal during ops, saw ${beats} heartbeats`);

  assert.deepEqual(docker.order, ["pull", "create", "healthy"]);
  const complete = client.calls.find((c) => c.method === "complete");
  assert.ok(complete);
  assert.deepEqual(complete.payload, { imageDigest: GOOD_DIGEST, commitSha: "b".repeat(40) });
  assert.ok(!client.calls.some((c) => c.method === "fail"));
});

test("health failure: no success report, owned container removed, bounded failure", async () => {
  const client = fakeClient();
  const docker = fakeDocker({
    owned: [OWN_NAME],
    healthyImpl: async () => { throw new EdgeDockerError("EDGE_HEALTH_CHECK_FAILED", "Health check failed: HTTP 500"); },
  });
  const outcome = await executeReadyPlan(
    { client: client.client, docker: docker.docker as never, heartbeatIntervalMs: 1000 },
    job(),
    { deploymentId: DEPLOYMENT_ID, projectId: PROJECT_ID, agentId: AGENT_ID },
    { kind: "ready", imageReference: GOOD_IMAGE },
    AbortSignal.timeout(30_000),
    undefined,
    AbortSignal.timeout(60_000)
  );
  assert.equal(outcome.result, "failed");
  assert.equal((outcome as { code: string }).code, "EDGE_HEALTH_CHECK_FAILED");
  assert.ok(!client.calls.some((c) => c.method === "complete"), "never succeed before health passes");
  assert.ok(client.calls.some((c) => c.method === "fail"), "failure must be reported");
  assert.ok(docker.removed.includes(OWN_NAME), "owned container must be cleaned up");
  assert.ok(!docker.removed.includes(PREVIOUS_NAME), "previous release container must be preserved");
});

test("pull failure reports without success and without orphaned creates", async () => {
  const client = fakeClient();
  const docker = fakeDocker({
    pullImpl: async () => { throw new EdgeDockerError("EDGE_PULL_FAILED", "Image pull failed: unauthorized"); },
  });
  const outcome = await executeReadyPlan(
    { client: client.client, docker: docker.docker as never },
    job(),
    { deploymentId: DEPLOYMENT_ID, projectId: PROJECT_ID, agentId: AGENT_ID },
    { kind: "ready", imageReference: GOOD_IMAGE },
    AbortSignal.timeout(30_000),
    undefined,
    AbortSignal.timeout(60_000)
  );
  assert.equal(outcome.result, "failed");
  assert.equal((outcome as { code: string }).code, "EDGE_PULL_FAILED");
  assert.ok(!docker.calls.some((c) => c.method === "create")), "must not create after pull failure";
  assert.ok(!client.calls.some((c) => c.method === "complete"));
  const fail = client.calls.find((c) => c.method === "fail");
  assert.ok(fail);
});

test("start failure cleans up and never reports success", async () => {
  const client = fakeClient();
  const docker = fakeDocker({
    owned: [OWN_NAME],
    createImpl: async () => { throw new EdgeDockerError("EDGE_START_FAILED", "Container startup failed: port in use"); },
  });
  const outcome = await executeReadyPlan(
    { client: client.client, docker: docker.docker as never },
    job(),
    { deploymentId: DEPLOYMENT_ID, projectId: PROJECT_ID, agentId: AGENT_ID },
    { kind: "ready", imageReference: GOOD_IMAGE },
    AbortSignal.timeout(30_000),
    undefined,
    AbortSignal.timeout(60_000)
  );
  assert.equal(outcome.result, "failed");
  assert.ok(docker.removed.includes(OWN_NAME));
  assert.ok(!client.calls.some((c) => c.method === "complete"));
});

test("lease lost mid-run stops execution and reports nothing", async () => {
  let beats = 0;
  const client = fakeClient({
    heartbeatImpl: () => {
      beats += 1;
      if (beats === 1) return runningState();
      throw new EdgeApiDefinitiveError("EDGE_LEASE_STALE", "stale", 409);
    },
  });
  const docker = fakeDocker({
    owned: [OWN_NAME],
    healthyImpl: async () => { await new Promise((r) => setTimeout(r, 2500)); },
  });
  const outcome = await executeReadyPlan(
    { client: client.client, docker: docker.docker as never, heartbeatIntervalMs: 1000 },
    job(),
    { deploymentId: DEPLOYMENT_ID, projectId: PROJECT_ID, agentId: AGENT_ID },
    { kind: "ready", imageReference: GOOD_IMAGE },
    AbortSignal.timeout(30_000),
    undefined,
    AbortSignal.timeout(60_000)
  );
  assert.equal(outcome.result, "lease-lost");
  assert.ok(!client.calls.some((c) => c.method === "complete" || c.method === "fail")), "lost lease: no blind reports";
  assert.ok(docker.removed.includes(OWN_NAME), "owned container must not be orphaned");
});

test("cancellation removes the owned container and reports nothing", async () => {
  const client = fakeClient();
  const caller = new AbortController();
  const docker = fakeDocker({
    owned: [OWN_NAME],
    healthyImpl: async () => {
      await new Promise((r) => setTimeout(r, 5000));
    },
  });

  const abortingDocker = {
    ...docker.docker,
    waitHealthy: async (_rt: unknown, s?: AbortSignal) => new Promise<void>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error("should have been aborted")), 5000);
      s?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new EdgeDockerError("EDGE_CANCELLED", "Health verification was cancelled"));
      }, { once: true });
      if (s?.aborted) {
        clearTimeout(t);
        reject(new EdgeDockerError("EDGE_CANCELLED", "Health verification was cancelled"));
      }
    }),
  };
  setTimeout(() => caller.abort(), 100);
  const outcome = await executeReadyPlan(
    { client: client.client, docker: abortingDocker as never, heartbeatIntervalMs: 1000 },
    job(),
    { deploymentId: DEPLOYMENT_ID, projectId: PROJECT_ID, agentId: AGENT_ID },
    { kind: "ready", imageReference: GOOD_IMAGE },
    AbortSignal.any([caller.signal, AbortSignal.timeout(30_000)]),
    caller.signal,
    AbortSignal.timeout(60_000)
  );
  assert.equal(outcome.result, "cancelled");
  assert.ok(docker.removed.includes(OWN_NAME), "cancellation must not orphan the container");
  assert.ok(!client.calls.some((c) => c.method === "complete" || c.method === "fail"));
});

test("ready plan revalidates the image: mutable tags fail closed", async () => {
  const client = fakeClient();
  const docker = fakeDocker();
  const outcome = await executeReadyPlan(
    { client: client.client, docker: docker.docker as never },
    job(),
    { deploymentId: DEPLOYMENT_ID, projectId: PROJECT_ID, agentId: AGENT_ID },
    { kind: "ready", imageReference: "registry.local/app:latest" },
    AbortSignal.timeout(30_000),
    undefined,
    AbortSignal.timeout(60_000)
  );
  assert.equal(outcome.result, "failed");
  assert.deepEqual(docker.calls, [], "no pull of a mutable tag");
  assert.ok(!client.calls.some((c) => c.method === "complete"));
});

test("failure payloads carry no credentials", async () => {
  const client = fakeClient();
  const docker = fakeDocker({
    pullImpl: async () => { throw new EdgeDockerError("EDGE_PULL_FAILED", "denied for Bearer super-secret-token hunter2"); },
  });
  await executeReadyPlan(
    { client: client.client, docker: docker.docker as never },
    job(),
    { deploymentId: DEPLOYMENT_ID, projectId: PROJECT_ID, agentId: AGENT_ID },
    { kind: "ready", imageReference: GOOD_IMAGE },
    AbortSignal.timeout(30_000),
    undefined,
    AbortSignal.timeout(60_000)
  );
  const fail = client.calls.find((c) => c.method === "fail");
  assert.ok(fail);
  const text = JSON.stringify(fail.payload);
  assert.ok(!text.includes("super-secret-token"), "credential must not reach the failure payload");
});

test("outcome of a timed-out completion is transient so callers reconcile", async () => {  const client = fakeClient({
    completeImpl: () => { throw new EdgeApiTransientError("timeout; outcome unknown"); },
  });
  const docker = fakeDocker();
  const outcome = await executeReadyPlan(
    { client: client.client, docker: docker.docker as never },
    job(),
    { deploymentId: DEPLOYMENT_ID, projectId: PROJECT_ID, agentId: AGENT_ID },
    { kind: "ready", imageReference: GOOD_IMAGE },
    AbortSignal.timeout(30_000),
    undefined,
    AbortSignal.timeout(60_000)
  );

  assert.equal(outcome.result, "transient");
  assert.equal((outcome as EdgeOutcome & { code: string }).code, "EDGE_REPORT_TRANSIENT");
});

const TRUSTED_REPO = "registry.local:5000/deploykit/project-app";

function jobWithTrustedImage(): ClaimedEdgeJob {
  return {
    ...job(),
    image: { repository: TRUSTED_REPO, digest: GOOD_DIGEST, releaseId: "77777777-7777-4777-8777-777777777777" },
  };
}

test("runOnce with a trusted image executes the ready path end to end", async () => {
  const client = fakeClient({ claimImpl: () => ({ job: jobWithTrustedImage() }) });
  const docker = fakeDocker();
  const outcome = await runEdgeDeploymentOnce(
    { client: client.client, docker: docker.docker as never, heartbeatIntervalMs: 1000 },
    AbortSignal.timeout(30_000)
  );
  assert.equal(outcome.result, "succeeded");
  const pull = docker.calls.find((c) => c.method === "pull");
  assert.ok(pull);
  assert.equal(pull.arg, `${TRUSTED_REPO}@${GOOD_DIGEST}`);
  assert.deepEqual(docker.order, ["pull", "create", "healthy"]);
  const complete = client.calls.find((c) => c.method === "complete");
  assert.ok(complete);
  assert.deepEqual(complete.payload, { imageDigest: GOOD_DIGEST, commitSha: "b".repeat(40) });
  assert.ok(!client.calls.some((c) => c.method === "fail"));
});

test("runOnce with a malformed image block fails closed without touching anything", async () => {
  const bad = jobWithTrustedImage() as unknown as Record<string, unknown>;
  bad.image = { repository: `${TRUSTED_REPO}:latest`, digest: GOOD_DIGEST, releaseId: null };
  const client = fakeClient({ claimImpl: () => ({ job: bad }) });
  const docker = fakeDocker();
  const outcome = await runEdgeDeploymentOnce({ client: client.client, docker: docker.docker as never });
  assert.equal(outcome.result, "transient");
  assert.equal((outcome as { code: string }).code, "EDGE_INVALID_CLAIM");
  assert.deepEqual(client.calls, [], "no server calls without a validated job");
  assert.deepEqual(docker.calls, []);
});
