import pool from "../db/database.js";
import { canTransition } from "../deployments/deploymentStateMachine.js";

const DEFAULT_LEASE_MS = 30_000;

export { DEFAULT_LEASE_MS };

export interface ClaimedJob {
  id: string;
  deploymentId: string;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
}

export async function claimNextJob(
  workerId: string,
  leaseMs = DEFAULT_LEASE_MS
): Promise<ClaimedJob | null> {
  const client = await pool.connect();

  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await claimNextJobAttempt(client, workerId, leaseMs);
      } catch (error) {
        if (
          attempt < 2 &&
          error instanceof Error &&
          "code" in error &&
          (error as { code?: string }).code === "40P01"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

async function claimNextJobAttempt(
  client: import("pg").PoolClient,
  workerId: string,
  leaseMs: number
): Promise<ClaimedJob | null> {
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      SELECT
        j.id,
        j.deployment_id,
        j.attempts,
        j.max_attempts
      FROM deployment_jobs j
      JOIN deployments d ON d.id = j.deployment_id
      WHERE
        d.target_agent_id IS NULL
        AND (
          (
            j.status = 'queued'
            AND j.available_at <= CURRENT_TIMESTAMP
            AND j.attempts < j.max_attempts
          )
          OR
          (
            j.status = 'running'
            AND j.lease_expires_at IS NOT NULL
            AND j.lease_expires_at <= CURRENT_TIMESTAMP
            AND j.attempts < j.max_attempts
          )
        )
      ORDER BY j.created_at ASC
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1
      `
    );

    if (result.rows.length === 0) {
      await client.query("COMMIT");
      return null;
    }

    const job = result.rows[0];

    const updatedJob = await client.query(
      `
      UPDATE deployment_jobs
      SET
        status = 'running',
        attempts = attempts + 1,
        locked_at = CURRENT_TIMESTAMP,
        locked_by = $2,
        lease_expires_at =
          CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond'),
        lease_token = gen_random_uuid(),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING
        id,
        deployment_id,
        attempts,
        max_attempts,
        lease_token
      `,
      [job.id, workerId, leaseMs]
    );

    if (updatedJob.rows.length !== 1) throw new Error("Failed to claim deployment job");

    const claimed = updatedJob.rows[0];

    const deploymentResult = await client.query(
      `
      SELECT status
      FROM deployments
      WHERE id = $1
      FOR UPDATE
      `,
      [claimed.deployment_id]
    );

    if (deploymentResult.rows.length !== 1) throw new Error("Deployment for queued job no longer exists");

    const previousStatus = deploymentResult.rows[0].status as string;

    const nextStatus =
      previousStatus === "queued" ? "cloning" : previousStatus;

    if (nextStatus !== previousStatus) {
      if (!canTransition(previousStatus as never, nextStatus as never)) {
        throw new Error(
          `Invalid deployment transition ${previousStatus} -> ${nextStatus}`
        );
      }
      await client.query(
        `
        UPDATE deployments
        SET
          status = 'cloning',
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [claimed.deployment_id]
      );
    } else {
      await client.query(
        `
        UPDATE deployments
        SET started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [claimed.deployment_id]
      );
    }

    await client.query(
      `
      INSERT INTO deployment_attempts (
        deployment_id, attempt_number, status, worker_id, started_at
      )
      VALUES ($1, $2, 'cloning', $3, CURRENT_TIMESTAMP)
      ON CONFLICT (deployment_id, attempt_number)
      DO UPDATE SET status = EXCLUDED.status,
                    worker_id = EXCLUDED.worker_id,
                    started_at = CURRENT_TIMESTAMP
      `,
      [claimed.deployment_id, claimed.attempts, workerId]
    );

    await client.query(
      `
      INSERT INTO deployment_events (
        deployment_id,
        event_type,
        status_from,
        status_to,
        message,
        metadata
      )
      VALUES (
        $1,
        'deployment.claimed',
        $2,
        $3,
        $4,
        $5::jsonb
      )
      `,
      [
        claimed.deployment_id,
        previousStatus,
        nextStatus,
        "Deployment claimed by worker",
        JSON.stringify({
          workerId,
          attempt: claimed.attempts,
          maxAttempts: claimed.max_attempts,
          leaseMs,
        }),
      ]
    );

    await client.query("COMMIT");

    return {
      id: claimed.id,
      deploymentId: claimed.deployment_id,
      attempts: claimed.attempts,
      maxAttempts: claimed.max_attempts,
      leaseToken: claimed.lease_token,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function extendJobLease(
  jobId: string,
  workerId: string,
  leaseToken: string,
  leaseMs = DEFAULT_LEASE_MS
): Promise<boolean> {
  const result = await pool.query(
    `
    UPDATE deployment_jobs
    SET
      lease_expires_at =
        CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond'),
      updated_at = CURRENT_TIMESTAMP
    WHERE
      id = $1
      AND status = 'running'
      AND locked_by = $2
      AND lease_token = $3
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > CURRENT_TIMESTAMP
    `,
    [jobId, workerId, leaseToken, leaseMs]
  );

  return result.rowCount === 1;
}

export function isEdgeBuildEnabled(): boolean {
  return process.env.DEPLOYKIT_EDGE_BUILD_ENABLED === "true";
}

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;

export class EdgeBuildError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EdgeBuildError";
    this.code = code;
  }
}

export interface ClaimedEdgeBuildJob {
  id: string;
  deploymentId: string;
  buildAttempt: number;
  maxBuildAttempts: number;
  leaseToken: string;
}

export interface EdgeBuiltImage {
  imageRepository: string;
  imageDigest: string;
  commitSha: string;
}

function isRegistryQualifiedRepository(repository: string): boolean {
  const host = repository.split("/")[0]?.toLowerCase() ?? "";
  return host === "localhost" || host.includes(".") || host.includes(":");
}

export async function claimNextEdgeBuildJob(
  workerId: string,
  leaseMs = DEFAULT_LEASE_MS
): Promise<ClaimedEdgeBuildJob | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      SELECT
        j.id,
        j.deployment_id,
        j.build_attempts,
        j.max_build_attempts
      FROM deployment_jobs j
      JOIN deployments d ON d.id = j.deployment_id
      WHERE
        d.target_agent_id IS NOT NULL
        AND j.job_phase = 'build'
        AND j.claimed_agent_id IS NULL
        AND j.build_attempts < j.max_build_attempts
        AND (
          (
            j.status = 'queued'
            AND j.available_at <= CURRENT_TIMESTAMP
          )
          OR
          (
            j.status = 'running'
            AND j.lease_expires_at IS NOT NULL
            AND j.lease_expires_at <= CURRENT_TIMESTAMP
          )
        )
      ORDER BY j.created_at ASC
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1
      `
    );

    if (result.rows.length === 0) {
      await client.query("COMMIT");
      return null;
    }

    const job = result.rows[0];

    const claimed = (
      await client.query(
        `
        UPDATE deployment_jobs
        SET
          status = 'running',
          build_attempts = build_attempts + 1,
          locked_at = CURRENT_TIMESTAMP,
          locked_by = $2,
          lease_expires_at =
            CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond'),
          lease_token = gen_random_uuid(),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING id, deployment_id, build_attempts, max_build_attempts,
                  lease_token
        `,
        [job.id, workerId, leaseMs]
      )
    ).rows[0] as {
      id: string;
      deployment_id: string;
      build_attempts: number;
      max_build_attempts: number;
      lease_token: string;
    };

    if (claimed.lease_token === null) {
      throw new EdgeBuildError("BUILD_LEASE_TOKEN_MISSING", "Failed to mint build lease token");
    }

    const deploymentResult = await client.query(
      `
      SELECT status
      FROM deployments
      WHERE id = $1
      FOR UPDATE
      `,
      [claimed.deployment_id]
    );

    if (deploymentResult.rows.length !== 1) {
      throw new EdgeBuildError("DEPLOYMENT_NOT_FOUND", "Deployment no longer exists");
    }

    const previousStatus = deploymentResult.rows[0].status as string;
    const nextStatus =
      previousStatus === "queued" ? "cloning" : previousStatus;

    if (nextStatus !== previousStatus) {
      if (!canTransition(previousStatus as never, nextStatus as never)) {
        throw new EdgeBuildError(
          "INVALID_DEPLOYMENT_TRANSITION",
          `Invalid deployment transition ${previousStatus} -> ${nextStatus}`
        );
      }
      await client.query(
        `
        UPDATE deployments
        SET status = 'cloning',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [claimed.deployment_id]
      );
    }




    await client.query(
      `
      INSERT INTO deployment_events (
        deployment_id,
        event_type,
        status_from,
        status_to,
        message,
        metadata
      )
      VALUES ($1, 'deployment.edge_build_claimed', $2, $3, $4, $5::jsonb)
      `,
      [
        claimed.deployment_id,
        previousStatus,
        nextStatus,
        "Edge build claimed by worker",
        JSON.stringify({
          workerId,
          buildAttempt: claimed.build_attempts,
          maxBuildAttempts: claimed.max_build_attempts,
          leaseMs,
        }),
      ]
    );

    await client.query("COMMIT");

    return {
      id: claimed.id,
      deploymentId: claimed.deployment_id,
      buildAttempt: claimed.build_attempts,
      maxBuildAttempts: claimed.max_build_attempts,
      leaseToken: claimed.lease_token,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function extendEdgeBuildLease(
  jobId: string,
  workerId: string,
  leaseToken: string,
  leaseMs = DEFAULT_LEASE_MS
): Promise<boolean> {
  const result = await pool.query(
    `
    UPDATE deployment_jobs
    SET lease_expires_at =
          CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
      AND status = 'running'
      AND job_phase = 'build'
      AND locked_by = $2
      AND lease_token = $3
    `,
    [jobId, workerId, leaseToken, leaseMs]
  );
  return result.rowCount === 1;
}

export async function completeEdgeBuildPhase(
  jobId: string,
  deploymentId: string,
  workerId: string,
  leaseToken: string,
  image: EdgeBuiltImage
): Promise<"completed" | "superseded"> {
  const digest = image.imageDigest.trim().toLowerCase();
  if (!SHA256_DIGEST_RE.test(digest)) {
    throw new EdgeBuildError(
      "EDGE_IMAGE_DIGEST_INVALID",
      "Build produced no verified immutable digest"
    );
  }
  if (!isRegistryQualifiedRepository(image.imageRepository)) {
    throw new EdgeBuildError(
      "EDGE_IMAGE_REPOSITORY_UNTRUSTED",
      "Build image repository is not registry-qualified"
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const jobResult = await client.query(
      `
      SELECT id, deployment_id
      FROM deployment_jobs
      WHERE id = $1
        AND status = 'running'
        AND job_phase = 'build'
        AND locked_by = $2
        AND lease_token = $3
      FOR UPDATE
      `,
      [jobId, workerId, leaseToken]
    );
    if (jobResult.rows.length !== 1) {
      throw new EdgeBuildError(
        "BUILD_LEASE_NOT_OWNED",
        "Build job is no longer owned by this worker"
      );
    }
    if (jobResult.rows[0].deployment_id !== deploymentId) {
      throw new EdgeBuildError(
        "BUILD_DEPLOYMENT_MISMATCH",
        "Build job does not belong to the requested deployment"
      );
    }

    const depResult = await client.query(
      `
      SELECT status, image_digest
      FROM deployments
      WHERE id = $1
      FOR UPDATE
      `,
      [deploymentId]
    );
    if (depResult.rows.length !== 1) {
      throw new EdgeBuildError("DEPLOYMENT_NOT_FOUND", "Deployment not found");
    }

    const previousStatus = depResult.rows[0].status as string;
    const existingDigest = (depResult.rows[0].image_digest ?? null) as string | null;
    const superseded = existingDigest !== null && existingDigest !== digest;

    if (!superseded && existingDigest === null) {
      await client.query(
        `
        UPDATE deployments
        SET commit_sha = $2,
            image_repository = $3,
            image_digest = $4,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [deploymentId, image.commitSha.toLowerCase(), image.imageRepository, digest]
      );
    }



    await client.query(
      `
      UPDATE deployment_jobs
      SET status = 'queued',
          job_phase = 'execute',
          available_at = CURRENT_TIMESTAMP,
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          lease_token = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [jobId]
    );

    if (canTransition(previousStatus as never, "queued" as never)) {
      await client.query(
        `
        UPDATE deployments
        SET status = 'queued',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [deploymentId]
      );
    }

    await client.query(
      `
      INSERT INTO deployment_events (
        deployment_id,
        event_type,
        status_from,
        status_to,
        message,
        metadata
      )
      VALUES ($1, 'deployment.edge_image_ready', $2, $3, $4, $5::jsonb)
      `,
      [
        deploymentId,
        previousStatus,
        canTransition(previousStatus as never, "queued" as never) ? "queued" : previousStatus,
        superseded
          ? "Edge build finished; an earlier digest was kept"
          : "Edge image built and verified; handed off to the edge agent",
        JSON.stringify({
          jobId,
          workerId,
          imageRepository: image.imageRepository,
          imageDigest: digest,
          commitSha: image.commitSha,
          superseded,
        }),
      ]
    );

    await client.query("COMMIT");
    return superseded ? "superseded" : "completed";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failEdgeBuildPhase(
  jobId: string,
  deploymentId: string,
  workerId: string,
  leaseToken: string,
  errorMessage: string,
  errorCode = "EDGE_BUILD_FAILED"
): Promise<"retrying" | "failed"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const jobResult = await client.query(
      `
      SELECT build_attempts, max_build_attempts
      FROM deployment_jobs
      WHERE id = $1
        AND status = 'running'
        AND job_phase = 'build'
        AND locked_by = $2
        AND lease_token = $3
      FOR UPDATE
      `,
      [jobId, workerId, leaseToken]
    );
    if (jobResult.rows.length !== 1) {
      throw new EdgeBuildError(
        "BUILD_LEASE_NOT_OWNED",
        "Build job is no longer owned by this worker"
      );
    }

    const buildAttempts = jobResult.rows[0].build_attempts as number;
    const maxBuildAttempts = jobResult.rows[0].max_build_attempts as number;
    const shouldRetry = buildAttempts < maxBuildAttempts;

    const depResult = await client.query(
      `
      SELECT status
      FROM deployments
      WHERE id = $1
      FOR UPDATE
      `,
      [deploymentId]
    );
    const previousStatus = (depResult.rows[0]?.status ?? "unknown") as string;
    const safeMessage = errorMessage.slice(0, 4000);
    const safeCode = errorCode.slice(0, 100);

    if (shouldRetry) {
      const backoffSeconds = Math.min(300, 2 ** Math.max(0, buildAttempts - 1));
      await client.query(
        `
        UPDATE deployment_jobs
        SET status = 'queued',
            job_phase = 'build',
            available_at = CURRENT_TIMESTAMP + ($2 * INTERVAL '1 second'),
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            lease_token = NULL,
            last_error = $3,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [jobId, backoffSeconds, safeMessage]
      );

      if (
        previousStatus !== "active" &&
        previousStatus !== "cancelled" &&
        canTransition(previousStatus as never, "queued" as never)
      ) {
        await client.query(
          `
          UPDATE deployments
          SET status = 'queued',
              error_code = $2,
              error_message = $3,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          `,
          [deploymentId, safeCode, safeMessage]
        );
      }

      await client.query(
        `
        INSERT INTO deployment_events (
          deployment_id, event_type, status_from, status_to, message, metadata
        )
        VALUES ($1,'deployment.edge_build_failed',$2,$3,
          'Edge build failed; job requeued for retry', $4::jsonb)
        `,
        [
          deploymentId,
          previousStatus,
          canTransition(previousStatus as never, "queued" as never) ? "queued" : previousStatus,
          JSON.stringify({
            jobId,
            buildAttempt: buildAttempts,
            maxBuildAttempts,
            backoffSeconds,
            errorCode: safeCode,
          }),
        ]
      );

      await client.query("COMMIT");
      return "retrying";
    }


    await client.query(
      `
      UPDATE deployment_jobs
      SET status = 'failed',
          build_attempts = GREATEST(build_attempts, max_build_attempts),
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          lease_token = NULL,
          last_error = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [jobId, safeMessage]
    );

    if (previousStatus !== "active" && previousStatus !== "cancelled") {
      await client.query(
        `
        UPDATE deployments
        SET status = 'failed',
            error_code = $2,
            error_message = $3,
            finished_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [deploymentId, safeCode, `${safeMessage}`]
      );
    }

    await client.query(
      `
      INSERT INTO deployment_events (
        deployment_id, event_type, status_from, status_to, message, metadata
      )
      VALUES ($1,'deployment.edge_build_failed',$2,'failed',
        'Edge build exhausted all build attempts', $3::jsonb)
      `,
      [
        deploymentId,
        previousStatus,
        JSON.stringify({
          jobId,
          buildAttempt: buildAttempts,
          maxBuildAttempts,
          errorCode: safeCode,
        }),
      ]
    );

    await client.query("COMMIT");
    return "failed";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function demoteEdgeBuildJobsWhenDisabled(): Promise<string[]> {
  if (isEdgeBuildEnabled()) {
    return [];
  }

  const result = await pool.query(
    `
    WITH demoted AS (
      UPDATE deployment_jobs j
      SET
        job_phase = 'execute',
        available_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      FROM deployments d
      WHERE j.deployment_id = d.id
        AND d.target_agent_id IS NOT NULL
        AND j.job_phase = 'build'
        AND j.status = 'queued'
      RETURNING j.id AS job_id, j.deployment_id
    )
    INSERT INTO deployment_events (
      deployment_id, event_type, status_from, status_to, message, metadata
    )
    SELECT
      demoted.deployment_id,
      'deployment.edge_build_demoted',
      d.status,
      d.status,
      'Edge build phase disabled; job handed to the execute phase, where it fails closed without a trusted image',
      jsonb_build_object(
        'jobId', demoted.job_id,
        'reason', 'EDGE_BUILD_DISABLED',
        'previousPhase', 'build',
        'phase', 'execute'
      )
    FROM demoted
    JOIN deployments d ON d.id = demoted.deployment_id
    RETURNING deployment_events.metadata ->> 'jobId' AS job_id
    `
  );

  return result.rows.map((row) => row.job_id as string);
}

export async function completeJob(
  jobId: string,
  deploymentId: string,
  workerId: string,
  leaseToken: string
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const jobResult = await client.query(
      `
      UPDATE deployment_jobs
      SET
        status = 'succeeded',
        locked_at = NULL,
        locked_by = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE
        id = $1
        AND status = 'running'
        AND locked_by = $2
        AND lease_token = $3
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > CURRENT_TIMESTAMP
      RETURNING id
      `,
      [jobId, workerId, leaseToken]
    );

    if (jobResult.rows.length !== 1) throw new Error("Deployment job is no longer owned by this worker");

    const dep = await client.query(
      `SELECT status FROM deployments WHERE id = $1 FOR UPDATE`,
      [deploymentId]
    );
    if (dep.rowCount === 0) throw new Error("Deployment not found");
    const from = dep.rows[0].status as string;
    if (from !== "deploying") {
      throw new Error(
        `Cannot complete deployment from status ${from}`
      );
    }

    await client.query(
      `
      UPDATE deployments
      SET
        status = 'active',
        finished_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [deploymentId]
    );

    await client.query(
      `
      INSERT INTO deployment_events (
        deployment_id,
        event_type,
        status_from,
        status_to,
        message,
        metadata
      )
      VALUES (
        $1,
        'deployment.completed',
        $2,
        'active',
        $3,
        $4::jsonb
      )
      `,
      [
        deploymentId,
        from,
        "Deployment completed successfully",
        JSON.stringify({
          workerId,
        }),
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverExpiredJobs(): Promise<number> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      SELECT
        j.id,
        j.deployment_id,
        j.attempts,
        j.max_attempts,
        j.job_phase,
        j.build_attempts,
        j.max_build_attempts,
        d.status AS deployment_status
      FROM deployment_jobs j
      JOIN deployments d ON d.id = j.deployment_id
      WHERE
        j.status = 'running'
        AND j.lease_expires_at IS NOT NULL
        AND j.lease_expires_at <= CURRENT_TIMESTAMP
      FOR UPDATE OF j SKIP LOCKED
      `
    );

    for (const job of result.rows) {
      const jobPhase = (job.job_phase ?? "execute") as string;
      const isBuildPhase = jobPhase === "build";
      const exhausted = isBuildPhase
        ? job.build_attempts >= job.max_build_attempts
        : job.attempts >= job.max_attempts;
      const prevStatus = job.deployment_status as string;

      if (exhausted) {
        await client.query(
          `
          UPDATE deployment_jobs
          SET
            status = 'failed',
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            lease_token = NULL,
            last_error = $2,
            build_attempts = CASE
              WHEN $3 THEN GREATEST(build_attempts, max_build_attempts)
              ELSE build_attempts
            END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          `,
          [
            job.id,
            isBuildPhase
              ? "Build lease expired after maximum build attempts"
              : "Worker lease expired after maximum attempts",
            isBuildPhase,
          ]
        );

        if (prevStatus !== "active" && prevStatus !== "failed" && prevStatus !== "cancelled") {
          await client.query(
            `
            UPDATE deployments
            SET
              status = 'failed',
              error_code = $2,
              error_message = $3,
              finished_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [
              job.deployment_id,
              isBuildPhase ? "EDGE_BUILD_LEASE_EXPIRED" : "WORKER_LEASE_EXPIRED",
              isBuildPhase
                ? "Build lease expired after maximum build attempts"
                : "Worker lease expired after maximum attempts",
            ]
          );
        }

        await client.query(
          `
          INSERT INTO deployment_events (
            deployment_id, event_type, status_from, status_to,
            message, metadata
          )
          VALUES ($1,'deployment.lease_expired',$2,'failed',
            'Worker lease expired; deployment failed',
            $3::jsonb)
          `,
          [
            job.deployment_id,
            prevStatus,
            JSON.stringify({
              jobId: job.id,
              attempts: job.attempts,
              maxAttempts: job.max_attempts,
            }),
          ]
        );
      } else {



        await client.query(
          `SELECT status FROM deployments WHERE id = $1 FOR UPDATE`,
          [job.deployment_id]
        );

        const canRequeue = canTransition(
          prevStatus as never,
          "queued" as never
        );

        if (canRequeue) {
          const recoveryDelaySeconds = isBuildPhase ? 30 : 0;
          await client.query(
            `
            UPDATE deployment_jobs
            SET
              status = 'queued',
              job_phase = $2,
              available_at =
                CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
              locked_at = NULL,
              locked_by = NULL,
              lease_expires_at = NULL,
              lease_token = NULL,
              last_error = $4,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [
              job.id,
              isBuildPhase ? "build" : "execute",
              recoveryDelaySeconds,
              isBuildPhase
                ? "Build lease expired; job recovered for another build attempt"
                : "Worker lease expired; job recovered",
            ]
          );
          await client.query(
            `
            UPDATE deployments
            SET
              status = 'queued',
              error_code = $2,
              error_message = $3,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [
              job.deployment_id,
              isBuildPhase ? "EDGE_BUILD_LEASE_EXPIRED" : "WORKER_LEASE_EXPIRED",
              isBuildPhase
                ? "Build lease expired; deployment requeued for another build"
                : "Worker lease expired; deployment requeued",
            ]
          );
        } else {
          await client.query(
            `
            UPDATE deployment_jobs
            SET
              status = 'failed',
              locked_at = NULL,
              locked_by = NULL,
              lease_expires_at = NULL,
              lease_token = NULL,
              last_error = $2,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [
              job.id,
              isBuildPhase
                ? "Build lease expired; deployment is terminal"
                : "Worker lease expired; deployment is terminal",
            ]
          );
        }

        const nextStatus = canRequeue ? "queued" : prevStatus;

        await client.query(
          `
          INSERT INTO deployment_events (
            deployment_id, event_type, status_from, status_to,
            message, metadata
          )
          VALUES ($1,'deployment.lease_recovered',$2,$3,
            'Worker lease expired; job recovered',
            $4::jsonb)
          `,
          [
            job.deployment_id,
            prevStatus,
            nextStatus,
            JSON.stringify({
              jobId: job.id,
              attempts: job.attempts,
              maxAttempts: job.max_attempts,
            }),
          ]
        );
      }
    }

    await client.query("COMMIT");

    return result.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failJobTerminal(
  jobId: string,
  deploymentId: string,
  workerId: string,
  leaseToken: string,
  errorMessage: string,
  errorCode = "DEPLOYMENT_FAILED"
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const jobResult = await client.query(
      `
      SELECT attempts, max_attempts FROM deployment_jobs
      WHERE id = $1 AND status = 'running' AND locked_by = $2
        AND lease_token = $3
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > CURRENT_TIMESTAMP
      FOR UPDATE
      `,
      [jobId, workerId, leaseToken]
    );
    if (jobResult.rows.length !== 1) throw new Error("Deployment job is no longer owned by this worker");
    const safeMessage = errorMessage.slice(0, 4000);
    const dep = await client.query(
      `SELECT status FROM deployments WHERE id = $1 FOR UPDATE`,
      [deploymentId]
    );
    const previousStatus =
      dep.rows[0]?.status ?? "unknown";
    await client.query(
      `
      UPDATE deployment_jobs
      SET status = 'failed', locked_at = NULL, locked_by = NULL,
          lease_expires_at = NULL, lease_token = NULL, last_error = $2,
          attempts = GREATEST(attempts, max_attempts),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND lease_token = $3
      `,
      [jobId, safeMessage, leaseToken]
    );
    if (
      previousStatus !== "active" &&
      previousStatus !== "cancelled" &&
      previousStatus !== "failed"
    ) {
      await client.query(
        `
        UPDATE deployments
        SET status = 'failed', error_code = $2, error_message = $3,
            finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [deploymentId, errorCode, safeMessage]
      );
    }
    await client.query(
      `
      INSERT INTO deployment_events (
        deployment_id, event_type, status_from, status_to, message, metadata
      )
      VALUES ($1,'deployment.failed',$2,'failed',$3,$4::jsonb)
      `,
      [
        deploymentId,
        previousStatus,
        "Deployment failed without retry",
        JSON.stringify({ error: safeMessage.slice(0, 1000) }),
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failJob(
  jobId: string,
  deploymentId: string,
  workerId: string,
  leaseToken: string,
  errorMessage: string,
  errorCode?: string
): Promise<"retrying" | "failed"> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const jobResult = await client.query(
      `
      SELECT
        attempts,
        max_attempts
      FROM deployment_jobs
      WHERE
        id = $1
        AND status = 'running'
        AND locked_by = $2
        AND lease_token = $3
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > CURRENT_TIMESTAMP
      FOR UPDATE
      `,
      [jobId, workerId, leaseToken]
    );

    if (jobResult.rows.length !== 1) throw new Error("Deployment job is no longer owned by this worker");

    const job = jobResult.rows[0];
    const shouldRetry = job.attempts < job.max_attempts;

    const deploymentResult = await client.query(
      `
      SELECT status
      FROM deployments
      WHERE id = $1
      FOR UPDATE
      `,
      [deploymentId]
    );

    if (deploymentResult.rows.length !== 1) throw new Error("Deployment associated with job was not found");

    const previousStatus = deploymentResult.rows[0].status as string;
    const safeMessage = errorMessage.slice(0, 4000);
    const retryCode = (errorCode ?? "DEPLOYMENT_RETRY").slice(0, 100);
    const failedCode = (errorCode ?? "DEPLOYMENT_FAILED").slice(0, 100);

    if (shouldRetry) {
      const backoffSeconds = Math.min(
        300,
        2 ** Math.max(0, job.attempts - 1)
      );

      await client.query(
        `
        UPDATE deployment_jobs
        SET
          status = 'queued',
          available_at =
            CURRENT_TIMESTAMP + ($2 * INTERVAL '1 second'),
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          lease_token = NULL,
          last_error = $3,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND lease_token = $4
        `,
        [jobId, backoffSeconds, safeMessage, leaseToken]
      );

      if (
        previousStatus !== "active" &&
        previousStatus !== "cancelled"
      ) {
        const canRequeue = canTransition(
          previousStatus as never,
          "queued" as never
        );
        if (canRequeue) {
          await client.query(
            `
            UPDATE deployments
            SET
              status = 'queued',
              error_code = $3,
              error_message = $2,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [deploymentId, safeMessage, retryCode]
          );
        }
      }

      await client.query(
        `
        INSERT INTO deployment_events (
          deployment_id,
          event_type,
          status_from,
          status_to,
          message,
          metadata
        )
        VALUES (
          $1,
          'deployment.retry_scheduled',
          $2,
          'queued',
          $3,
          $4::jsonb
        )
        `,
        [
          deploymentId,
          previousStatus,
          "Deployment failed and was requeued",
          JSON.stringify({
            attempt: job.attempts,
            maxAttempts: job.max_attempts,
            backoffSeconds,
            errorCode: retryCode,
            error: safeMessage.slice(0, 1000),
          }),
        ]
      );

      await client.query(
        `
        UPDATE deployment_attempts
        SET status = 'failed',
            error_message = $3,
            finished_at = CURRENT_TIMESTAMP
        WHERE deployment_id = $1 AND attempt_number = $2
        `,
        [deploymentId, job.attempts, safeMessage.slice(0, 2000)]
      );

      await client.query("COMMIT");

      return "retrying";
    }

    await client.query(
      `
      UPDATE deployment_jobs
      SET
        status = 'failed',
        locked_at = NULL,
        locked_by = NULL,
        lease_expires_at = NULL,
        lease_token = NULL,
        last_error = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND lease_token = $3
      `,
      [jobId, safeMessage, leaseToken]
    );

    if (
      previousStatus !== "active" &&
      previousStatus !== "cancelled" &&
      previousStatus !== "failed"
    ) {
      await client.query(
        `
        UPDATE deployments
        SET
          status = 'failed',
          error_code = $3,
          error_message = $2,
          finished_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [deploymentId, safeMessage, failedCode]
      );
    }

    await client.query(
      `
      INSERT INTO deployment_events (
        deployment_id,
        event_type,
        status_from,
        status_to,
        message,
        metadata
      )
      VALUES (
        $1,
        'deployment.failed',
        $2,
        'failed',
        $3,
        $4::jsonb
      )
      `,
      [
        deploymentId,
        previousStatus,
        "Deployment exhausted all retry attempts",
        JSON.stringify({
          attempts: job.attempts,
          maxAttempts: job.max_attempts,
          errorCode: failedCode,
          error: safeMessage.slice(0, 1000),
        }),
      ]
    );

    await client.query(
      `
      UPDATE deployment_attempts
      SET status = 'failed',
          error_message = $3,
          finished_at = CURRENT_TIMESTAMP
      WHERE deployment_id = $1 AND attempt_number = $2
      `,
      [deploymentId, job.attempts, safeMessage.slice(0, 2000)]
    );

    await client.query("COMMIT");

    return "failed";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
