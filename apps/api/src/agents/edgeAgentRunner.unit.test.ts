// Phase 12.5: edge agent runner tests (fakes; no DB, no Docker daemon).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  EdgeAgentRunner,
  runEdgeAgentFromEnv,
  type EdgeLogEntry,
} from "./edgeAgentRunner.js";
import {
  EdgeApiDefinitiveError,
  EdgeApiTransientError,
} from "./edgeAgentClient.js";
import type { ExecResult } from "../infrastructure/process/dockerExec.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4434-8344-444444444444";
const GOOD_DIGEST = `sha256:${"c".repeat(64)}`;
const TRUSTED_REPO = "registry.local:5000/deploykit/app";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DEPLOYKIT_CONTROL_PLANE_URL: "https://control.example.com",
    DEPLOYKIT_AGENT_TOKEN: "a".repeat(64),
    DEPLOYKIT_EDGE_POLL_INTERVAL_MS: "1000",
    DEPLOYKIT_EDGE_HEARTBEAT_INTERVAL_MS: "1000",
    DEPLOYKIT_EDGE_EXECUTION_TIMEOUT_MS: "30000",
  };
}

function job(image: unknown = null) {
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
    image,
  };
}

function runningState() {
  return {
    job: { id: JOB_ID, deploymentId: DEPLOYMENT_ID, status: "running", attempts: 1, maxAttempts: 3, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() },
    deployment: { id: DEPLOYMENT_ID, status: "cloning" },
  };
}

function okResult(stdout = ""): ExecResult {
  return { stdout, stderr: "", code: 0, timedOut: false, aborted: false };
}

interface Harness {
  claims: number;
  completes: number;
  fails: number;
  sleeps: number[];
  logs: EdgeLogEntry[];
  claimImpl: () => Promise<unknown>;
  dockerCalls: string[];
}

function makeHarness(overrides: Partial<Harness> = {}): Harness & {
  factories: ConstructorParameters<typeof EdgeAgentRunner>[1];
} {
  const h: Harness = {
    claims: 0,
    completes: 0,
    fails: 0,
    sleeps: [],
    logs: [],
    claimImpl: overrides.claimImpl ?? (async () => ({ job: null })),
    dockerCalls: [],
  };
  Object.assign(h, overrides);
  // Attach factories to the LIVE harness object (no spread copy: scalar
  // counters must stay shared between the fakes and the assertions).
  const withFactories = h as Harness & {
    factories: ConstructorParameters<typeof EdgeAgentRunner>[1];
  };
  withFactories.factories = {
    createClient: () => ({
      claimJob: async () => { h.claims += 1; return h.claimImpl(); },
      heartbeatJob: async () => runningState(),
      completeJob: async () => { h.completes += 1; return { ok: true }; },
      failJob: async () => { h.fails += 1; return { ok: true }; },
    }),
    createDocker: () => ({
      pullImage: async (ref: string) => { h.dockerCalls.push(`pull ${ref}`); return ref; },
      createAndStart: (async () => {
        h.dockerCalls.push("create");
        return { containerName: "dk-p33333333-d22222222", containerPort: 3000, ipAddress: "172.18.0.5", networkName: "n", healthPath: "/", containerId: "d".repeat(64) };
      }) as never,
      waitHealthy: async () => { h.dockerCalls.push("healthy"); },
      stopAndRemoveOwned: async (name: string) => { h.dockerCalls.push(`remove ${name}`); },
      listOwnedContainers: async () => [],
    }),
    runFn: async () => okResult("25.0.3"),
    sleep: async (ms: number) => {
      h.sleeps.push(ms);
      // Yield to the event loop so test timers (stop conditions) can fire;
      // a purely microtask sleep would starve them and spin unbounded.
      await new Promise((r) => setTimeout(r, 0));
    },
    log: (entry: EdgeLogEntry) => { h.logs.push(entry); },
  };
  return withFactories;
}

test("docker preflight failure prevents job execution", async () => {
  const h = makeHarness();
  const runner = new EdgeAgentRunner(baseEnv(), {
    ...h.factories,
    runFn: async () => ({ ...okResult(), code: 1, stderr: "Cannot connect to the Docker daemon" }),
  });
  const code = await runner.run();
  assert.equal(code, 3);
  assert.equal(h.claims, 0);
  const failed = h.logs.find((l) => l.event === "docker.preflight_failed");
  assert.ok(failed);
  assert.ok(!JSON.stringify(failed).includes("a".repeat(64)), "no credential in preflight logs");
});

test("missing docker network fails preflight with an actionable message", async () => {
  const h = makeHarness();
  let calls = 0;
  const runner = new EdgeAgentRunner(baseEnv(), {
    ...h.factories,
    runFn: async (_b: string, args: string[]) => {
      calls += 1;
      if (args[0] === "network") return { ...okResult(), code: 1, stderr: "No such network" };
      return okResult("25.0.3");
    },
  });
  const code = await runner.run();
  assert.equal(code, 3);
  assert.equal(calls, 2);
  const failed = h.logs.find((l) => l.event === "docker.preflight_failed");
  assert.ok(failed && String(failed.error).includes("DEPLOYKIT_EDGE_NETWORK"));
});

test("shutdown stops polling and prevents new claims", async () => {
  const h = makeHarness();
  const runner = new EdgeAgentRunner(baseEnv(), h.factories);
  const done = runner.run();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(h.claims >= 1, "expected polling to start");
  runner.stop();
  runner.stop(); // idempotent
  const code = await done;
  assert.equal(code, 0);
  assert.ok(runner.isStopping);
  const frozen = h.claims;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.claims, frozen, "no new claims after shutdown");
  assert.ok(h.logs.some((l) => l.event === "agent.shutdown"));
});

test("transient API failure uses bounded exponential backoff", async () => {
  const h = makeHarness({
    claimImpl: async () => { throw new EdgeApiTransientError("timeout; outcome unknown"); },
  });
  const runner = new EdgeAgentRunner(
    { ...baseEnv(), DEPLOYKIT_EDGE_POLL_INTERVAL_MS: "4000" },
    h.factories
  );
  const done = runner.run();
  await new Promise((r) => setTimeout(r, 60));
  runner.stop();
  await done;
  assert.ok(h.sleeps.length >= 5, `expected several backoff sleeps, saw ${h.sleeps.length}`);
  for (let i = 1; i < h.sleeps.length; i += 1) {
    assert.ok(h.sleeps[i] >= h.sleeps[i - 1], "backoff must not shrink");
    assert.ok(h.sleeps[i] <= 60_000, "backoff must be capped");
  }
  assert.ok(h.sleeps.includes(60_000), "backoff must reach the 60s cap");
  assert.equal(h.completes, 0);
});

test("reconnection re-claims and revalidates instead of blindly rerunning", async () => {
  let calls = 0;
  const h = makeHarness({
    claimImpl: async () => {
      calls += 1;
      if (calls === 1) throw new EdgeApiTransientError("control-plane outage");
      return { job: job(null) };
    },
  });
  const runner = new EdgeAgentRunner(baseEnv(), h.factories);
  const done = runner.run();
  await new Promise((r) => setTimeout(r, 60));
  runner.stop();
  await done;
  assert.ok(calls >= 2, "must re-claim after the outage");
  // Null image: fail-closed blocked path reports failure, runs no container.
  assert.ok(h.fails >= 1);
  assert.deepEqual(h.dockerCalls, []);
  assert.equal(h.completes, 0);
});

test("invalid image metadata stays fail-closed end to end", async () => {
  const h = makeHarness({
    claimImpl: async () => ({ job: { ...job(null), image: { repository: "x:latest", digest: "nope", releaseId: null } } }),
  });
  const runner = new EdgeAgentRunner(baseEnv(), h.factories);
  const done = runner.run();
  await new Promise((r) => setTimeout(r, 50));
  runner.stop();
  await done;
  assert.deepEqual(h.dockerCalls, [], "no Docker work on malformed image");
  assert.equal(h.completes, 0, "never succeed on malformed image");
});

test("trusted image claim executes the full path through the runner", async () => {
  const h = makeHarness({
    claimImpl: async () => ({
      job: job({ repository: TRUSTED_REPO, digest: GOOD_DIGEST, releaseId: null }),
    }),
  });
  const runner = new EdgeAgentRunner(baseEnv(), h.factories);
  const done = runner.run();
  await new Promise((r) => setTimeout(r, 60));
  runner.stop();
  await done;
  assert.deepEqual(h.dockerCalls.slice(0, 3), [`pull ${TRUSTED_REPO}@${GOOD_DIGEST}`, "create", "healthy"]);
  assert.ok(h.completes >= 1);
  assert.ok(h.logs.some((l) => l.event === "agent.job_succeeded"));
});

test("revoked credential stops the agent with a distinct exit code", async () => {
  const h = makeHarness({
    claimImpl: async () => ({ job: job(null) }),
  });
  const runner = new EdgeAgentRunner(baseEnv(), {
    ...h.factories,
    createClient: () => ({
      claimJob: async () => { h.claims += 1; return { job: job(null) }; },
      heartbeatJob: async () => { throw new EdgeApiDefinitiveError("EDGE_AGENT_UNAUTHORIZED", "revoked", 401); },
      completeJob: async () => { h.completes += 1; return { ok: true }; },
      failJob: async () => { h.fails += 1; return { ok: true }; },
    }),
  });
  const code = await runner.run();
  assert.equal(code, 4);
  const frozen = h.claims;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.claims, frozen, "no polling after revocation");
  assert.ok(h.logs.some((l) => l.event === "agent.revoked"));
});

test("invalid configuration exits 2 without throwing or leaking", async () => {
  const logs: EdgeLogEntry[] = [];
  const code = await runEdgeAgentFromEnv(
    { DEPLOYKIT_CONTROL_PLANE_URL: "https://cp.example.com" },
    { log: (e) => { logs.push(e); } }
  );
  assert.equal(code, 2);
  assert.ok(logs.some((l) => l.event === "agent.config_invalid"));
});

test("runner and entry never embed the central worker", () => {
  const dir = path.join(__dirname, ".");
  for (const file of [
    "edgeAgentRunner.ts",
    "edgeAgentConfig.ts",
    "edgeAgentClient.ts",
    "edgeDocker.ts",
    "edgeExecutor.ts",
    "edgeJobSchema.ts",
  ]) {
    const source = readFileSync(path.join(dir, file), "utf8");
    for (const forbidden of ["deploymentWorker", "claimNextJob", "RealDeploymentExecutor", "deploymentPipeline", "recoverExpiredJobs"]) {
      assert.ok(!source.includes(forbidden), `${file} must not reference central worker symbol ${forbidden}`);
    }
  }
  const entry = readFileSync(path.join(dir, "..", "edgeAgent.ts"), "utf8");
  assert.ok(!entry.includes("deploymentWorker"));
});
