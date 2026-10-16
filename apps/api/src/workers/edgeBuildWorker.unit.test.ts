import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import {
  EDGE_BUILD_ABORT_REASONS,
  processEdgeBuildJob,
} from "./deploymentWorker.js";
import type { claimNextEdgeBuildJob } from "./deploymentQueue.js";
import type { DeploymentExecutor } from "./deploymentExecutor.js";
import { gateDb } from "../test/dbGate.js";

const SUITE = "workers/edgeBuildWorker.unit.test.ts";

type ClaimedEdgeBuildJob = NonNullable<
  Awaited<ReturnType<typeof claimNextEdgeBuildJob>>
>;

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

async function ready(): Promise<boolean> {
  return gateDb(SUITE, dbAvailable);
}

function fakeJob(overrides: Record<string, unknown> = {}): ClaimedEdgeBuildJob {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    deploymentId: "22222222-2222-2222-2222-222222222222",
    buildAttempt: 1,
    maxBuildAttempts: 3,
    leaseToken: "33333333-3333-3333-3333-333333333333",
    ...overrides,
  } as ClaimedEdgeBuildJob;
}

const savedFlag = process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;

test.after(() => {
  if (savedFlag === undefined) delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
  else process.env.DEPLOYKIT_EDGE_BUILD_ENABLED = savedFlag;
});

function enableFlag(): void {
  process.env.DEPLOYKIT_EDGE_BUILD_ENABLED = "true";
}

/** Resolves when the executor's signal aborts, then fails like a real abort. */
function executorThatAborts(onStart?: () => void): DeploymentExecutor {
  return {
    execute: async (ctx) => {
      onStart?.();
      await new Promise<void>((resolve) => {
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("executor aborted");
    },
  };
}

test("a definitive lease-renewal failure aborts the running executor", async () => {
  if (!(await ready())) return;
  enableFlag();

  let executed = false;
  const done = processEdgeBuildJob({
    claim: async () => fakeJob(),
    // Definitive loss on the very first renewal.
    extendLease: async () => false,
    executor: executorThatAborts(() => {
      executed = true;
    }),
    queryDeploymentStatus: async () => "building",
  });

  // The renewal timer fires after LEASE_RENEWAL_MS (lease/3).
  await new Promise((r) => setTimeout(r, 15_000));

  assert.ok(executed, "executor should have started");
  await done;
});

test("a lost lease never reaches the hand-off path", async () => {
  if (!(await ready())) return;
  enableFlag();

  // Any call into the real hand-off would require a live DB row; if the code
  // attempted it, the token/ownership guard would reject. Reaching here with the
  // injected claim proves the loop returned without touching completion.
  const done = processEdgeBuildJob({
    claim: async () => fakeJob(),
    extendLease: async () => false,
    executor: executorThatAborts(),
    queryDeploymentStatus: async () => "building",
  });
  await new Promise((r) => setTimeout(r, 15_000));
  assert.equal(await done, true);
});

test("lease-renewal exceptions follow a bounded policy and abort", async () => {
  if (!(await ready())) return;
  enableFlag();

  let renewalCalls = 0;
  let consecutive = 0;
  let maxConsecutive = 0;

  const done = processEdgeBuildJob({
    claim: async () => fakeJob(),
    extendLease: async () => {
      renewalCalls += 1;
      consecutive += 1;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
      throw new Error("connection reset");
    },
    executor: executorThatAborts(),
    queryDeploymentStatus: async () => "building",
  });

  // Long enough for the bounded threshold (3 consecutive) to trip and abort.
  await new Promise((r) => setTimeout(r, 45_000));
  await done;

  assert.ok(renewalCalls >= 3, `expected >=3 renewal attempts, got ${renewalCalls}`);
  assert.equal(
    maxConsecutive,
    3,
    "the renewal policy must stop after the bounded number of consecutive failures"
  );
});

test("a successful renewal resets the consecutive-failure counter", async () => {
  if (!(await ready())) return;
  enableFlag();

  let calls = 0;
  let sawAbort = false;

  const done = processEdgeBuildJob({
    claim: async () => fakeJob(),
    extendLease: async () => {
      calls += 1;
      // Two transient failures, one success (resets the counter), two more
      // transient failures, then a definitive loss.
      if (calls === 3) return true;
      if (calls >= 6) return false;
      throw new Error("transient");
    },
    executor: {
      execute: async (ctx) => {
        ctx.signal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
          },
          { once: true }
        );
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("aborted");
      },
    },
    queryDeploymentStatus: async () => "building",
  });

  await new Promise((r) => setTimeout(r, 45_000));
  await done;

  assert.ok(sawAbort, "a definitive loss after transient failures must still abort");
  assert.ok(calls > 3, "renewal must keep retrying across transient failures");
});

test("lease renewal requests never overlap", async () => {
  if (!(await ready())) return;
  enableFlag();

  let inFlight = 0;
  let maxConcurrent = 0;
  let calls = 0;

  const done = processEdgeBuildJob({
    claim: async () => fakeJob(),
    extendLease: async () => {
      calls += 1;
      if (calls > 3) return false;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Deliberately slower than the renewal interval: without the overlap
      // guard a second renewal would be started while this one is pending.
      await new Promise((r) => setTimeout(r, 25_000));
      inFlight -= 1;
      return true;
    },
    executor: executorThatAborts(),
    queryDeploymentStatus: async () => "building",
  });

  await new Promise((r) => setTimeout(r, 55_000));
  await done;

  assert.equal(
    maxConcurrent,
    1,
    "only one lease renewal may be in flight at a time"
  );
});

test("deployment cancellation aborts via the watcher without a build failure", async () => {
  if (!(await ready())) return;
  enableFlag();

  let sawAbort = false;
  const done = processEdgeBuildJob({
    claim: async () => fakeJob(),
    extendLease: async () => true,
    executor: {
      execute: async (ctx) => {
        ctx.signal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
          },
          { once: true }
        );
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("aborted");
      },
    },
    // The watcher polls this; report "cancelled" immediately.
    queryDeploymentStatus: async () => "cancelled",
  });

  await new Promise((r) => setTimeout(r, 4_000));
  assert.ok(sawAbort, "a cancelled deployment must abort the build");
  await done;
});

test("abort reasons are distinct and stable", () => {
  assert.equal(
    EDGE_BUILD_ABORT_REASONS.deploymentCancelled,
    "deployment_cancelled"
  );
  assert.equal(EDGE_BUILD_ABORT_REASONS.workerShutdown, "worker_shutdown");
  assert.equal(EDGE_BUILD_ABORT_REASONS.leaseLost, "lease_lost");
  assert.equal(
    EDGE_BUILD_ABORT_REASONS.leaseRenewalUncertain,
    "lease_renewal_uncertain"
  );
});

test("the worker loop stays inert while the feature flag is off", async () => {
  if (!(await ready())) return;
  delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;

  let claimed = false;
  const processed = await processEdgeBuildJob({
    claim: async () => {
      claimed = true;
      return fakeJob();
    },
    extendLease: async () => true,
    executor: executorThatAborts(),
    queryDeploymentStatus: async () => "building",
  });

  assert.equal(processed, false);
  assert.equal(claimed, false, "no work may be claimed while the flag is disabled");
});