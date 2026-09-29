import { randomUUID } from "node:crypto";
import {
  claimNextJob,
  extendJobLease,
  failJob,
  recoverExpiredJobs,
} from "./deploymentQueue.js";
import {
  DeploymentExecutor,
  UnconfiguredDeploymentExecutor,
} from "./deploymentExecutor.js";

const WORKER_ID =
  process.env.WORKER_ID ?? `worker-${randomUUID()}`;

const POLL_INTERVAL_MS = Number(
  process.env.WORKER_POLL_INTERVAL_MS ?? 2000
);

const LEASE_MS = Number(
  process.env.WORKER_LEASE_MS ?? 30_000
);

const LEASE_RENEWAL_MS = Math.max(
  1_000,
  Math.floor(LEASE_MS / 3)
);

let shuttingDown = false;

const executor: DeploymentExecutor =
  new UnconfiguredDeploymentExecutor();

function log(
  level: "info" | "error",
  event: string,
  metadata: Record<string, unknown> = {}
) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    workerId: WORKER_ID,
    ...metadata,
  };

  const output = JSON.stringify(entry);

  if (level === "error") {
    console.error(output);
  } else {
    console.log(output);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function processJob() {
  const job = await claimNextJob(
    WORKER_ID,
    LEASE_MS
  );

  if (!job) {
    return false;
  }

  log("info", "deployment.job_claimed", {
    jobId: job.id,
    deploymentId: job.deploymentId,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
  });

  let leaseTimer: NodeJS.Timeout | undefined;

  try {
    leaseTimer = setInterval(async () => {
      try {
        const renewed = await extendJobLease(
          job.id,
          WORKER_ID,
          LEASE_MS
        );

        if (!renewed) {
          log("error", "deployment.lease_lost", {
            jobId: job.id,
            deploymentId: job.deploymentId,
          });
        }
      } catch (error) {
        log("error", "deployment.lease_renewal_failed", {
          jobId: job.id,
          deploymentId: job.deploymentId,
          error:
            error instanceof Error
              ? error.message
              : "Unknown error",
        });
      }
    }, LEASE_RENEWAL_MS);

    const result = await executor.execute({
      deploymentId: job.deploymentId,
      jobId: job.id,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
    });

    log("info", "deployment.execution_finished", {
      jobId: job.id,
      deploymentId: job.deploymentId,
      commitSha: result.commitSha,
      imageRepository: result.imageRepository,
      imageDigest: result.imageDigest,
    });

    /*
     * The executor will later update the deployment to `verifying`.
     * Only then should completeJob() be called by the final execution
     * pipeline after health/readiness verification.
     */

    return true;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown deployment execution error";

    log("error", "deployment.execution_failed", {
      jobId: job.id,
      deploymentId: job.deploymentId,
      attempt: job.attempts,
      error: message,
    });

    await failJob(
      job.id,
      job.deploymentId,
      WORKER_ID,
      message
    );

    return true;
  } finally {
    if (leaseTimer) {
      clearInterval(leaseTimer);
    }
  }
}

async function run() {
  /*
   * Safety gate:
   * the worker must not accidentally execute deployments before
   * the secure executor is installed.
   */
  if (process.env.DEPLOYMENT_WORKER_ENABLED !== "true") {
    log(
      "info",
      "worker.disabled",
      {
        reason:
          "DEPLOYMENT_WORKER_ENABLED is not true",
      }
    );

    return;
  }

  log("info", "worker.started", {
    pollIntervalMs: POLL_INTERVAL_MS,
    leaseMs: LEASE_MS,
  });

  while (!shuttingDown) {
    try {
      await recoverExpiredJobs();

      const processed = await processJob();

      if (!processed) {
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (error) {
      log("error", "worker.loop_error", {
        error:
          error instanceof Error
            ? error.message
            : "Unknown worker error",
      });

      await sleep(POLL_INTERVAL_MS);
    }
  }

  log("info", "worker.stopped");
}

function requestShutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  log("info", "worker.shutdown_requested", {
    signal,
  });
}

process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGINT", () => requestShutdown("SIGINT"));

run().catch((error) => {
  log("error", "worker.fatal_error", {
    error:
      error instanceof Error
        ? error.stack ?? error.message
        : "Unknown worker error",
  });

  process.exitCode = 1;
});
