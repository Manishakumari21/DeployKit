import test from "node:test";
import assert from "node:assert/strict";

import {
  createIntervalSweep,
  processDeploymentJob,
} from "./deploymentWorker.js";
import type { claimNextJob } from "./deploymentQueue.js";
import type { DeploymentExecutor } from "./deploymentExecutor.js";

type ClaimedJob = NonNullable<Awaited<ReturnType<typeof claimNextJob>>>;

function fakeJob(overrides: Record<string, unknown> = {}): ClaimedJob {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    deploymentId: "22222222-2222-2222-2222-222222222222",
    attempts: 1,
    maxAttempts: 3,
    leaseToken: "33333333-3333-3333-3333-333333333333",
    ...overrides,
  } as ClaimedJob;
}

function executorThatAborts(onStart?: () => void): DeploymentExecutor {
  return {
    execute: async (ctx) => {
      onStart?.();
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) {
          resolve();
          return;
        }
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("executor aborted");
    },
  };
}

test("a lost lease aborts the running executor (lease loss is not advisory)", async () => {
  let executed = false;
  let aborted = false;
  const promise = processDeploymentJob({
    claim: async () => fakeJob(),
    extendLease: async () => false,
    leaseRenewalMs: 20,
    cancelPollMs: 20,
    readDeploymentStatus: async () => "building",
    executor: {
      execute: async (ctx) => {
        executed = true;
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
        throw new Error("executor aborted");
      },
    } as DeploymentExecutor,
    complete: async () => undefined,
    fail: async () => "retrying" as const,
    failTerminal: async () => undefined,
    release: async () => true,
  });

  await promise;
  assert.equal(executed, true, "the executor must have started");
  assert.equal(aborted, true, "the executor must be aborted when the lease is lost");
});

test("a cancelled deployment aborts the executor without recording a failure", async () => {
  let failed = false;
  let released = false;
  await processDeploymentJob({
    claim: async () => fakeJob(),
    extendLease: async () => false,
    leaseRenewalMs: 20,
    cancelPollMs: 20,
    readDeploymentStatus: async () => "cancelled",
    executor: executorThatAborts(),
    complete: async () => undefined,
    fail: async () => {
      failed = true;
      return "retrying" as const;
    },
    failTerminal: async () => {
      failed = true;
    },
    release: async () => {
      released = true;
      return true;
    },
  });
  assert.equal(failed, false, "a cancelled deployment must not be recorded as failed");
  assert.equal(released, false, "a cancelled deployment must not release the lease");
});

test("a worker shutdown releases the lease so the job can be picked up immediately", async () => {
  let released = false;
  let failCalled = false;
  let shuttingDown = false;

  await processDeploymentJob({
    claim: async () => fakeJob(),
    extendLease: async () => true,
    leaseRenewalMs: 20,
    cancelPollMs: 20,
    readDeploymentStatus: async () => "building",
    isShuttingDown: () => shuttingDown,
    executor: {
      execute: async (ctx) => {
        setTimeout(() => {
          shuttingDown = true;
        }, 10);
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("executor aborted");
      },
    } as DeploymentExecutor,
    complete: async () => undefined,
    fail: async () => {
      failCalled = true;
      return "retrying" as const;
    },
    failTerminal: async () => {
      failCalled = true;
    },
    release: async () => {
      released = true;
      return true;
    },
  });

  assert.equal(failCalled, false, "a shutdown must not burn a retry attempt");
  assert.equal(released, true, "a shutdown must release the lease for immediate pickup");
});

test("the interval sweep runs once per interval and again after it elapses", async () => {
  let runs = 0;
  const sweep = createIntervalSweep(1_000, async () => {
    runs += 1;
    return runs;
  });

  assert.equal(await sweep.sweep(0), 1);
  assert.equal(await sweep.sweep(500), null, "must not run again inside the interval");
  assert.equal(await sweep.sweep(1_000), 2, "must run once the interval elapsed");
  assert.equal(await sweep.sweep(1_500), null);
  assert.equal(runs, 2);
});
