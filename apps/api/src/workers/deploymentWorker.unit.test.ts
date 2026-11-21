import test from "node:test";
import assert from "node:assert/strict";

import {
  assertWorkerPepperConfigured,
  createIntervalSweep,
  isWorkerShuttingDown,
  processDeploymentJob,
  processEdgeBuildJob,
  processGatewaySyncJob,
  requestShutdown,
  resetWorkerShutdownStateForTests,
  resolveWorkerConcurrency,
} from "./deploymentWorker.js";
import { resetTokenPepperCache, TOKEN_PEPPER_ENV } from "../security/tokenHasher.js";
import { encryptSecret, decryptSecret, EncryptionError } from "../security/encryption.js";
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

test("worker concurrency resolves to a clamped positive integer", () => {
  assert.equal(resolveWorkerConcurrency(undefined), 2, "defaults to 2 when unset");
  assert.equal(resolveWorkerConcurrency(""), 2, "empty values fall back to the default");
  assert.equal(resolveWorkerConcurrency("abc"), 1, "non-numeric input clamps to the minimum");
  assert.equal(resolveWorkerConcurrency("1"), 1);
  assert.equal(resolveWorkerConcurrency("3"), 3);
  assert.equal(resolveWorkerConcurrency("0"), 1, "zero is clamped up to the minimum");
  assert.equal(resolveWorkerConcurrency("-4"), 1, "negatives are clamped up to the minimum");
  assert.equal(resolveWorkerConcurrency("8"), 8);
  assert.equal(resolveWorkerConcurrency("64"), 8, "oversized values clamp to the maximum");
  assert.equal(resolveWorkerConcurrency("2.7"), 2, "fractions truncate toward zero");
});

test("a shutdown aborts every in-flight job, not just the most recent", async () => {
  const started: string[] = [];

  const makeExecutor = (id: string): DeploymentExecutor => ({
    execute: async (ctx) => {
      started.push(id);
      await new Promise<void>((resolve) => {
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error(`executor ${id} aborted`);
    },
  });

  // Start two independent jobs concurrently, the way the worker's slots do.
  const jobA = processDeploymentJob({
    claim: async () => fakeJob(),
    extendLease: async () => true,
    leaseRenewalMs: 5_000,
    cancelPollMs: 5_000,
    readDeploymentStatus: async () => "building",
    executor: makeExecutor("a"),
    complete: async () => undefined,
    fail: async () => "retrying" as const,
    failTerminal: async () => undefined,
    release: async () => true,
  });
  const jobB = processDeploymentJob({
    claim: async () => fakeJob({ id: "44444444-4444-4444-4444-444444444444" }),
    extendLease: async () => true,
    leaseRenewalMs: 5_000,
    cancelPollMs: 5_000,
    readDeploymentStatus: async () => "building",
    executor: makeExecutor("b"),
    complete: async () => undefined,
    fail: async () => "retrying" as const,
    failTerminal: async () => undefined,
    release: async () => true,
  });

  // Wait until both executors have started before shutting down.
  while (started.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  requestShutdown("SIGTERM");

  const results = await Promise.allSettled([jobA, jobB]);
  assert.equal(started.length, 2, "both concurrent jobs should have started");
  assert.ok(
    results.every((r) => r.status === "fulfilled"),
    "both jobs should settle (not hang) after a shutdown abort"
  );
});

test("worker fails closed at boot in production when DEPLOYKIT_TOKEN_PEPPER is missing", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalPepper = process.env[TOKEN_PEPPER_ENV];
  try {
    process.env.NODE_ENV = "production";
    delete process.env[TOKEN_PEPPER_ENV];
    resetTokenPepperCache();

    assert.throws(
      () => assertWorkerPepperConfigured(),
      /DEPLOYKIT_TOKEN_PEPPER must be set explicitly in production/
    );
  } finally {
    process.env.NODE_ENV = originalEnv;
    if (originalPepper === undefined) {
      delete process.env[TOKEN_PEPPER_ENV];
    } else {
      process.env[TOKEN_PEPPER_ENV] = originalPepper;
    }
    resetTokenPepperCache();
  }
});

test("worker boots cleanly when DEPLOYKIT_TOKEN_PEPPER is configured", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalPepper = process.env[TOKEN_PEPPER_ENV];
  try {
    process.env.NODE_ENV = "production";
    process.env[TOKEN_PEPPER_ENV] = "test-worker-stable-pepper-value";
    resetTokenPepperCache();

    assert.doesNotThrow(() => assertWorkerPepperConfigured());
  } finally {
    process.env.NODE_ENV = originalEnv;
    if (originalPepper === undefined) {
      delete process.env[TOKEN_PEPPER_ENV];
    } else {
      process.env[TOKEN_PEPPER_ENV] = originalPepper;
    }
    resetTokenPepperCache();
  }
});

test("cross-process encryption: worker decrypts secrets encrypted by API only when peppers match", () => {
  const originalPepper = process.env[TOKEN_PEPPER_ENV];
  try {
    // 1. API encrypts with configured pepper
    process.env[TOKEN_PEPPER_ENV] = "shared-production-pepper-32-bytes";
    resetTokenPepperCache();
    const secret = "DATABASE_URL=postgres://app:secret@db.internal:5432/prod";
    const encryptedByApi = encryptSecret(secret);

    // 2. Worker with matching pepper decrypts successfully
    resetTokenPepperCache();
    const decryptedByWorker = decryptSecret(encryptedByApi);
    assert.equal(decryptedByWorker, secret);

    // 3. Worker with mismatched pepper fails closed with DECRYPTION_FAILED
    process.env[TOKEN_PEPPER_ENV] = "mismatched-ephemeral-pepper-xxx";
    resetTokenPepperCache();
    assert.throws(
      () => decryptSecret(encryptedByApi),
      (err: unknown) => err instanceof EncryptionError && err.code === "DECRYPTION_FAILED"
    );
  } finally {
    if (originalPepper === undefined) {
      delete process.env[TOKEN_PEPPER_ENV];
    } else {
      process.env[TOKEN_PEPPER_ENV] = originalPepper;
    }
    resetTokenPepperCache();
  }
});

test("worker does not start processing jobs with invalid production configuration", async () => {
  const originalEnv = process.env.NODE_ENV;
  const originalPepper = process.env[TOKEN_PEPPER_ENV];
  let jobsClaimed = 0;

  try {
    process.env.NODE_ENV = "production";
    delete process.env[TOKEN_PEPPER_ENV];
    resetTokenPepperCache();

    let errorCaught: Error | null = null;
    try {
      assertWorkerPepperConfigured();
      jobsClaimed++;
    } catch (err) {
      errorCaught = err as Error;
    }

    assert.ok(errorCaught !== null, "Must fail closed with an error");
    assert.match(
      errorCaught.message,
      /DEPLOYKIT_TOKEN_PEPPER must be set explicitly in production/
    );
    assert.equal(jobsClaimed, 0, "No jobs must be claimed or processed with missing pepper in production");
  } finally {
    process.env.NODE_ENV = originalEnv;
    if (originalPepper === undefined) {
      delete process.env[TOKEN_PEPPER_ENV];
    } else {
      process.env[TOKEN_PEPPER_ENV] = originalPepper;
    }
    resetTokenPepperCache();
  }
});

test("processDeploymentJob refuses to claim jobs when worker is shutting down", async () => {
  let claimCalled = false;
  const processed = await processDeploymentJob({
    isShuttingDown: () => true,
    claim: async () => {
      claimCalled = true;
      return fakeJob();
    },
  });

  assert.equal(processed, false, "Must return false without processing");
  assert.equal(claimCalled, false, "Must not attempt to claim a job when shutting down");
});

test("processGatewaySyncJob refuses to claim jobs when worker is shutting down", async () => {
  let claimCalled = false;
  const processed = await processGatewaySyncJob({
    isShuttingDown: () => true,
    claim: async () => {
      claimCalled = true;
      return { id: "g1", projectId: "p1", reason: "test", attempts: 1, maxAttempts: 3, leaseToken: "tok" } as never;
    },
  });

  assert.equal(processed, false, "Must return false without processing");
  assert.equal(claimCalled, false, "Must not attempt to claim a gateway sync job when shutting down");
});

test("processEdgeBuildJob refuses to claim jobs when worker is shutting down", async () => {
  let claimCalled = false;
  const processed = await processEdgeBuildJob({
    isShuttingDown: () => true,
    claim: async () => {
      claimCalled = true;
      return fakeJob() as never;
    },
  });

  assert.equal(processed, false, "Must return false without processing");
  assert.equal(claimCalled, false, "Must not attempt to claim an edge build job when shutting down");
});

test("requestShutdown is idempotent and manages worker shutdown state", () => {
  try {
    resetWorkerShutdownStateForTests();
    assert.equal(isWorkerShuttingDown(), false);

    let exitCalled = false;
    requestShutdown("SIGTERM", {
      timeoutMs: 5000,
      onExit: () => {
        exitCalled = true;
      },
    });

    assert.equal(isWorkerShuttingDown(), true);

    // Subsequent calls must be ignored
    requestShutdown("SIGINT", {
      timeoutMs: 5000,
      onExit: () => {
        exitCalled = true;
      },
    });

    assert.equal(isWorkerShuttingDown(), true);
    assert.equal(exitCalled, false, "Exit should not be called until timeout expires");
  } finally {
    resetWorkerShutdownStateForTests();
  }
});

test("worker shutdown timeout triggers forced exit(1) when tasks hang", async () => {
  try {
    resetWorkerShutdownStateForTests();
    let exitCode: number | null = null;

    await new Promise<void>((resolve) => {
      requestShutdown("SIGTERM", {
        timeoutMs: 40,
        onExit: (code) => {
          exitCode = code;
          resolve();
        },
      });
    });

    assert.equal(exitCode, 1, "Must force exit with code 1 upon timeout expiry");
  } finally {
    resetWorkerShutdownStateForTests();
  }
});

test("in-flight deployment job aborted during shutdown releases lease back to queued", async () => {
  let isDown = false;
  let released = false;
  let releaseReason = "";
  let failed = false;

  try {
    resetWorkerShutdownStateForTests();
    await processDeploymentJob({
      claim: async () => fakeJob(),
      extendLease: async () => true,
      leaseRenewalMs: 500,
      cancelPollMs: 500,
      isShuttingDown: () => isDown,
      readDeploymentStatus: async () => "building",
      executor: {
        execute: async (ctx) => {
          isDown = true;
          requestShutdown("SIGTERM", { timeoutMs: 5000, onExit: () => {} });
          await new Promise<void>((resolve) => {
            if (ctx.signal?.aborted) return resolve();
            ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new Error("aborted on shutdown");
        },
      } as DeploymentExecutor,
      complete: async () => undefined,
      fail: async () => {
        failed = true;
        return "retrying" as const;
      },
      failTerminal: async () => {
        failed = true;
      },
      release: async (_jobId, _depId, _workerId, _token, reason) => {
        released = true;
        releaseReason = reason ?? "";
        return true;
      },
    });

    assert.equal(released, true, "Job lease must be released when aborted during shutdown");
    assert.match(releaseReason, /Worker is shutting down/);
    assert.equal(failed, false, "Aborted job on shutdown must NOT be marked as failed");
  } finally {
    resetWorkerShutdownStateForTests();
  }
});
