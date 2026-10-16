import { randomUUID } from "node:crypto";
import {
  claimNextJob,
  completeJob,
  extendJobLease,
  failJob,
  failJobTerminal,
  recoverExpiredJobs,
  claimNextEdgeBuildJob,
  completeEdgeBuildPhase,
  demoteEdgeBuildJobsWhenDisabled,
  extendEdgeBuildLease,
  failEdgeBuildPhase,
  isEdgeBuildEnabled,
  EdgeBuildError,
} from "./deploymentQueue.js";
import pool from "../db/database.js";
import type { DeploymentExecutor } from "./deploymentExecutor.js";
import { RealDeploymentExecutor } from "./deploymentPipeline.js";
import { PipelineError } from "../deployments/deploymentErrors.js";
import { redactForLog } from "../agents/edgeJobSchema.js";
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
    log("error", "certificate.maintenance_failed", {
      error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
    });
  } finally {
    certSweepInProgress = false;
  }
}

let shuttingDown = false;
let activeAbort: AbortController | null = null;

export const EDGE_BUILD_ABORT_REASONS = {
  deploymentCancelled: "deployment_cancelled",
  workerShutdown: "worker_shutdown",
  leaseLost: "lease_lost",
  leaseRenewalUncertain: "lease_renewal_uncertain",
} as const;

type EdgeBuildAbortReason =
  (typeof EDGE_BUILD_ABORT_REASONS)[keyof typeof EDGE_BUILD_ABORT_REASONS];

const MAX_CONSECUTIVE_RENEWAL_FAILURES = 3;

async function settleQuietly(op: Promise<void> | null): Promise<void> {
  if (op === null) return;
  try {
    await op;
  } catch {
  }
}

const executor: DeploymentExecutor = new RealDeploymentExecutor();

function log(
  level: "info" | "error",
  event: string,
  metadata: Record<string, unknown> = {}
) {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    safe[key] = typeof value === "string" ? redactForLog(value) : value;
  }
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    workerId: WORKER_ID,
    ...safe,
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

    if (result.duplicateConverged) {
      const adopted = result.duplicateConverged.adoptedReleaseId;
      log("info", "deployment.duplicate_converged", {
        jobId: job.id,
        deploymentId: job.deploymentId,
        adoptedReleaseId: adopted,
      });
      await failJobTerminal(
        job.id,
        job.deploymentId,
        WORKER_ID,
        `DUPLICATE_EXECUTION_CONVERGED: duplicate execution converged onto release ${adopted}`,
        "DUPLICATE_EXECUTION_CONVERGED"
      );
      return true;
    }

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
        await failJob(job.id, job.deploymentId, WORKER_ID, `${code}: ${message}`, code);
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

export interface EdgeBuildJobDependencies {
  executor?: DeploymentExecutor;
  extendLease?: typeof extendEdgeBuildLease;
  claim?: typeof claimNextEdgeBuildJob;
  queryDeploymentStatus?: (deploymentId: string) => Promise<string | undefined>;
}

export async function processEdgeBuildJob(
  deps: EdgeBuildJobDependencies = {}
) {
  if (!isEdgeBuildEnabled()) {
    return false;
  }

  const buildExecutor = deps.executor ?? executor;
  const extendLease = deps.extendLease ?? extendEdgeBuildLease;
  const claim = deps.claim ?? claimNextEdgeBuildJob;
  const readDeploymentStatus =
    deps.queryDeploymentStatus ??
    (async (deploymentId: string) => {
      const current = await pool.query(
        `SELECT status FROM deployments WHERE id = $1`,
        [deploymentId]
      );
      return current.rows[0]?.status as string | undefined;
    });

  const job = await claim(WORKER_ID, LEASE_MS);
  if (!job) {
    return false;
  }

  log("info", "edge_build.job_claimed", {
    jobId: job.id,
    deploymentId: job.deploymentId,
    buildAttempt: job.buildAttempt,
    maxBuildAttempts: job.maxBuildAttempts,
  });

  let leaseTimer: NodeJS.Timeout | undefined;
  let cancelWatcher: NodeJS.Timeout | undefined;
  const abort = new AbortController();
  activeAbort = abort;

  let abortReason: EdgeBuildAbortReason | null = null;
  const requestAbort = (reason: EdgeBuildAbortReason) => {
    if (abortReason !== null) {
      return;
    }
    abortReason = reason;
    log("info", "edge_build.abort_requested", {
      jobId: job.id,
      deploymentId: job.deploymentId,
      reason,
    });
    abort.abort();
  };

  let renewalOp: Promise<void> | null = null;
  let watcherOp: Promise<void> | null = null;
  let consecutiveRenewalFailures = 0;

  try {
    leaseTimer = setInterval(() => {
      if (renewalOp !== null) {
        return;
      }
      renewalOp = (async () => {
        try {
          const renewed = await extendLease(
            job.id,
            WORKER_ID,
            job.leaseToken,
            LEASE_MS
          );
          if (renewed) {
            consecutiveRenewalFailures = 0;
            return;
          }
          log("error", "edge_build.lease_lost", {
            jobId: job.id,
            deploymentId: job.deploymentId,
          });
          requestAbort(EDGE_BUILD_ABORT_REASONS.leaseLost);
        } catch (error) {
          consecutiveRenewalFailures += 1;
          log("error", "edge_build.lease_renewal_failed", {
            jobId: job.id,
            deploymentId: job.deploymentId,
            consecutiveFailures: consecutiveRenewalFailures,
            error: redactForLog(
              error instanceof Error ? error.message : "Unknown error"
            ).slice(0, 200),
          });
          if (consecutiveRenewalFailures >= MAX_CONSECUTIVE_RENEWAL_FAILURES) {
            log("error", "edge_build.lease_renewal_uncertain", {
              jobId: job.id,
              deploymentId: job.deploymentId,
              consecutiveFailures: consecutiveRenewalFailures,
            });
            requestAbort(EDGE_BUILD_ABORT_REASONS.leaseRenewalUncertain);
          }
        }
      })().finally(() => {
        renewalOp = null;
      });
    }, LEASE_RENEWAL_MS);

    cancelWatcher = setInterval(() => {
      if (watcherOp !== null) {
        return;
      }
      watcherOp = (async () => {
        try {
          const currentStatus = await readDeploymentStatus(job.deploymentId);
          if (currentStatus === "cancelled") {
            log("info", "edge_build.cancel_requested", {
              jobId: job.id,
              deploymentId: job.deploymentId,
            });
            requestAbort(EDGE_BUILD_ABORT_REASONS.deploymentCancelled);
          }
        } catch {
        }
      })().finally(() => {
        watcherOp = null;
      });
    }, 2000);

    const result = await buildExecutor.execute({
      deploymentId: job.deploymentId,
      jobId: job.id,
      attempt: job.buildAttempt,
      maxAttempts: job.maxBuildAttempts,
      signal: abort.signal,
    });

    if (!result.edgeImageOnly) {
      throw new EdgeBuildError(
        "EDGE_BUILD_UNEXPECTED_RESULT",
        "Edge build produced a non-build-only result; refusing to hand off"
      );
    }

    const outcome = await completeEdgeBuildPhase(
      job.id,
      job.deploymentId,
      WORKER_ID,
      job.leaseToken,
      {
        imageRepository: result.imageRepository,
        imageDigest: result.imageDigest,
        commitSha: result.commitSha,
      }
    );

    log("info", "edge_build.job_handed_off", {
      jobId: job.id,
      deploymentId: job.deploymentId,
      outcome,
      imageDigest: result.imageDigest,
    });
    return true;
  } catch (error) {
    if (
      error instanceof EdgeBuildError &&
      error.code === "BUILD_LEASE_NOT_OWNED"
    ) {
      requestAbort(EDGE_BUILD_ABORT_REASONS.leaseLost);
    }

    const reason: EdgeBuildAbortReason | null =
      abortReason ?? (shuttingDown ? EDGE_BUILD_ABORT_REASONS.workerShutdown : null);

    if (reason !== null) {
      log("info", "edge_build.aborted", {
        jobId: job.id,
        deploymentId: job.deploymentId,
        reason,
      });
      return true;
    }

    const cancelled =
      error instanceof PipelineError &&
      error.code === "DEPLOYMENT_CANCELLED";

    if (cancelled) {
      log("info", "edge_build.cancelled", {
        jobId: job.id,
        deploymentId: job.deploymentId,
      });
      return true;
    }

    const code =
      error instanceof EdgeBuildError
        ? error.code
        : error instanceof PipelineError
          ? error.code
          : "EDGE_BUILD_FAILED";
    const message =
      error instanceof Error ? error.message : "Unknown edge build error";

    try {
      const outcome = await failEdgeBuildPhase(
        job.id,
        job.deploymentId,
        WORKER_ID,
        job.leaseToken,
        redactForLog(message).slice(0, 2000),
        code
      );
      log("info", "edge_build.job_failed", {
        jobId: job.id,
        deploymentId: job.deploymentId,
        outcome,
        code,
      });
    } catch (failError) {
      log("error", "edge_build.fail_report_failed", {
        jobId: job.id,
        deploymentId: job.deploymentId,
        error:
          failError instanceof Error ? failError.message : "Unknown error",
      });
    }
    return true;
  } finally {
    if (leaseTimer) clearInterval(leaseTimer);
    if (cancelWatcher) clearInterval(cancelWatcher);
    await settleQuietly(renewalOp);
    await settleQuietly(watcherOp);
    if (activeAbort === abort) {
      activeAbort = null;
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

  try {
    const { reconcileActiveGateways } = await import("../services/gatewayService.js");
    const summary = await reconcileActiveGateways();
    if (summary.reconciled > 0 || summary.failed > 0 || summary.superseded > 0) {
      log("info", "worker.gateway_reconciled", { ...summary });
    }
  } catch (error) {
    log("error", "worker.gateway_reconcile_failed", {
      error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
    });
  }

  while (!shuttingDown) {
    try {
      await recoverExpiredJobs();

      const processed = await processJob();



      const builtEdge = isEdgeBuildEnabled() ? await processEdgeBuildJob() : false;

      const demoted = await demoteEdgeBuildJobsWhenDisabled();
      if (demoted.length > 0) {
        log("info", "edge_build.jobs_demoted", {
          count: demoted.length,
          jobIds: demoted.slice(0, 50),
        });
      }

      if (!processed && !builtEdge) {
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

  try {
    activeAbort?.abort();
  } catch {
  }
}

if (require.main === module) {
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
}
