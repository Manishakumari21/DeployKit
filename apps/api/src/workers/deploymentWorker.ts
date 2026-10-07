import { randomUUID } from "node:crypto";
import {
  claimNextJob,
  completeJob,
  extendJobLease,
  failJob,
  failJobTerminal,
  recoverExpiredJobs,
} from "./deploymentQueue.js";
import pool from "../db/database.js";
import type { DeploymentExecutor } from "./deploymentExecutor.js";
import { RealDeploymentExecutor } from "./deploymentPipeline.js";
import { PipelineError } from "../deployments/deploymentErrors.js";
import { BootstrapError, bootstrapWorker } from "./workerBootstrap.js";

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

// Certificate maintenance (Phase 11 TLS): due-date-driven sweep for ACME
// issuance/renewal, expiry marking, and orphan cleanup. Runs only on the
// worker (sole Docker/nginx/certs holder), at most every CERT_POLL_MS, never
// concurrently with itself, and never fails deployment processing.
const CERT_POLL_MS = Math.max(
  10_000,
  Number(process.env.DEPLOYKIT_CERT_POLL_INTERVAL_MS ?? 60_000)
);

let certSweepInProgress = false;
let lastCertSweepAt = 0;

async function runCertSweep(): Promise<void> {
  const now = Date.now();
  if (certSweepInProgress || now - lastCertSweepAt < CERT_POLL_MS) {
    return;
  }
  certSweepInProgress = true;
  lastCertSweepAt = now;
  try {
    const { runCertificateMaintenance } = await import("../services/certIssuanceService.js");
    const { LegoAcmeClient, SelfSignedAcmeClient, getAcmeConfig } = await import(
      "../tls/acmeClient.js"
    );
    const mode = (process.env.DEPLOYKIT_TLS_MODE ?? "acme").trim().toLowerCase();
    const acmeClient =
      mode === "self-signed"
        ? new SelfSignedAcmeClient()
        : new LegoAcmeClient(getAcmeConfig());
    const summary = await runCertificateMaintenance({ acmeClient });
    if (summary.claimed > 0 || summary.expired > 0 || summary.failed > 0) {
      log("info", "certificate.maintenance", { ...summary });
    }
  } catch (error) {
    // Missing ACME email/config is an operator setup state, not a crash:
    // domains wait in pending until configured. Everything else is logged
    // without touching deployment work.
    log("error", "certificate.maintenance_failed", {
      error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
    });
  } finally {
    certSweepInProgress = false;
  }
}

let shuttingDown = false;
let activeAbort: AbortController | null = null;

const executor: DeploymentExecutor = new RealDeploymentExecutor();

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
  let cancelWatcher: NodeJS.Timeout | undefined;
  const abort = new AbortController();
  activeAbort = abort;

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

    // Propagate API cancellation and worker shutdown to active work.
    // Polls deployment status; aborts the build/git/health processes via AbortSignal.
    cancelWatcher = setInterval(async () => {
      try {
        if (shuttingDown) {
          abort.abort();
          return;
        }
        const current = await pool.query(`SELECT status FROM deployments WHERE id = $1`, [job.deploymentId]);
        if (current.rows[0]?.status === "cancelled") {
          log("info", "deployment.cancel_requested", {
            jobId: job.id,
            deploymentId: job.deploymentId,
          });
          abort.abort();
        }
      } catch {
        // Watcher must never fail the job; pipeline phase checks are authoritative.
      }
    }, 2000);

    const result = await executor.execute({
      deploymentId: job.deploymentId,
      jobId: job.id,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      signal: abort.signal,
    });

    log("info", "deployment.execution_finished", {
      jobId: job.id,
      deploymentId: job.deploymentId,
      commitSha: result.commitSha,
      imageRepository: result.imageRepository,
      imageDigest: result.imageDigest,
    });

    await completeJob(job.id, job.deploymentId, WORKER_ID);

    log("info", "deployment.job_completed", {
      jobId: job.id,
      deploymentId: job.deploymentId,
    });

    return true;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown deployment execution error";
    const code =
      error instanceof PipelineError ? error.code : "EXECUTION_FAILED";

    log("error", "deployment.execution_failed", {
      jobId: job.id,
      deploymentId: job.deploymentId,
      attempt: job.attempts,
      error: message,
      code,
    });

    // Cancellation and shutdown must not resurrect the job: the API cancel path
    // already moved deployment+job to `cancelled`, and shutdown aborts leave the
    // lease to expire for recovery. Never call failJob in those cases.
    if (
      code === "DEPLOYMENT_CANCELLED" ||
      code === "BUILD_CANCELLED" ||
      abort.signal.aborted
    ) {
      try {
        const current = await pool.query(`SELECT status FROM deployments WHERE id = $1`, [job.deploymentId]);
        if (current.rows[0]?.status === "cancelled") {
          log("info", "deployment.cancel_acknowledged", {
            jobId: job.id,
            deploymentId: job.deploymentId,
          });
          return true;
        }
      } catch {
        // Fall through to normal failure handling if status check fails.
      }
      if (shuttingDown || abort.signal.aborted) {
        log("info", "deployment.aborted_shutdown", {
          jobId: job.id,
          deploymentId: job.deploymentId,
        });
        return true;
      }
    }

    try {
      if (error instanceof PipelineError && !error.retryable) {
        await failJobTerminal(
          job.id,
          job.deploymentId,
          WORKER_ID,
          `${code}: ${message}`,
          code
        );
      } else {
        await failJob(job.id, job.deploymentId, WORKER_ID, message);
      }
    } catch (failError) {
      log("error", "deployment.fail_recording_failed", {
        jobId: job.id,
        deploymentId: job.deploymentId,
        error:
          failError instanceof Error
            ? failError.message
            : "Unknown error",
      });
    }

    return true;
  } finally {
    activeAbort = null;
    if (leaseTimer) {
      clearInterval(leaseTimer);
    }
    if (cancelWatcher) {
      clearInterval(cancelWatcher);
    }
  }
}

async function run() {
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

  try {
    const bootstrap = await bootstrapWorker();
    log("info", "worker.processing", {
      builder: bootstrap.builderName,
      buildxConfigDir: bootstrap.buildxConfigDir,
      registryHost: bootstrap.registryHost,
    });
  } catch (error) {
    const code = error instanceof BootstrapError ? error.code : "BOOTSTRAP_FAILED";
    log("error", "worker.bootstrap_failed", {
      error: error instanceof Error ? error.message : "Unknown bootstrap error",
      code,
    });
    process.exitCode = 1;
    return;
  }

  while (!shuttingDown) {
    try {
      await recoverExpiredJobs();

      const processed = await processJob();

      if (!processed) {
        // Idle worker time doubles as the certificate sweep slot: no extra
        // processes, no new job system, bounded by CERT_POLL_MS.
        await runCertSweep();
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

  // Terminate active git/docker/health work where technically supported.
  // The job lease then expires and is recovered; no orphan subprocess remains
  // under DeployKit's control beyond the BuildKit session disconnect.
  try {
    activeAbort?.abort();
  } catch {
    // Abort must never throw during shutdown.
  }
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
