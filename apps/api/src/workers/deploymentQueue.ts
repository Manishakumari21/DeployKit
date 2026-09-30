import pool from "../db/database.js";
import { canTransition } from "../deployments/deploymentStateMachine.js";

const DEFAULT_LEASE_MS = 30_000;

export interface ClaimedJob {
  id: string;
  deploymentId: string;
  attempts: number;
  maxAttempts: number;
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
        id,
        deployment_id,
        attempts,
        max_attempts
      FROM deployment_jobs
      WHERE
        (
          status = 'queued'
          AND available_at <= CURRENT_TIMESTAMP
          AND attempts < max_attempts
        )
        OR
        (
          status = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= CURRENT_TIMESTAMP
          AND attempts < max_attempts
        )
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
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
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING
        id,
        deployment_id,
        attempts,
        max_attempts
      `,
      [job.id, workerId, leaseMs]
    );

    if (updatedJob.rows.length !== 1) {
      throw new Error("Failed to claim deployment job");
    }

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

    if (deploymentResult.rows.length !== 1) {
      throw new Error("Deployment for queued job no longer exists");
    }

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
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function extendJobLease(
  jobId: string,
  workerId: string,
  leaseMs = DEFAULT_LEASE_MS
): Promise<boolean> {
  const result = await pool.query(
    `
    UPDATE deployment_jobs
    SET
      lease_expires_at =
        CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond'),
      updated_at = CURRENT_TIMESTAMP
    WHERE
      id = $1
      AND status = 'running'
      AND locked_by = $2
    `,
    [jobId, workerId, leaseMs]
  );

  return result.rowCount === 1;
}

export async function completeJob(
  jobId: string,
  deploymentId: string,
  workerId: string
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
      RETURNING id
      `,
      [jobId, workerId]
    );

    if (jobResult.rows.length !== 1) {
      throw new Error(
        "Deployment job is no longer owned by this worker"
      );
    }

    const dep = await client.query(
      `SELECT status FROM deployments WHERE id = $1 FOR UPDATE`,
      [deploymentId]
    );
    if (dep.rowCount === 0) {
      throw new Error("Deployment not found");
    }
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
      const exhausted = job.attempts >= job.max_attempts;
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
            last_error = 'Worker lease expired after maximum attempts',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          `,
          [job.id]
        );

        if (prevStatus !== "active" && prevStatus !== "failed" && prevStatus !== "cancelled") {
          await client.query(
            `
            UPDATE deployments
            SET
              status = 'failed',
              error_code = 'WORKER_LEASE_EXPIRED',
              error_message =
                'Worker lease expired after maximum attempts',
              finished_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [job.deployment_id]
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
          `
          UPDATE deployment_jobs
          SET
            status = 'queued',
            available_at = CURRENT_TIMESTAMP,
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            last_error = 'Worker lease expired; job recovered',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          `,
          [job.id]
        );

        const canRequeue = canTransition(
          prevStatus as never,
          "queued" as never
        );
        const nextStatus = canRequeue ? "queued" : prevStatus;
        if (canRequeue) {
          await client.query(
            `
            UPDATE deployments
            SET
              status = 'queued',
              error_code = 'WORKER_LEASE_EXPIRED',
              error_message =
                'Worker lease expired; deployment requeued',
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [job.deployment_id]
          );
        }

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
      FOR UPDATE
      `,
      [jobId, workerId]
    );
    if (jobResult.rows.length !== 1) {
      throw new Error(
        "Deployment job is no longer owned by this worker"
      );
    }
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
          lease_expires_at = NULL, last_error = $2,
          attempts = GREATEST(attempts, max_attempts),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [jobId, safeMessage]
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
  errorMessage: string
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
      FOR UPDATE
      `,
      [jobId, workerId]
    );

    if (jobResult.rows.length !== 1) {
      throw new Error(
        "Deployment job is no longer owned by this worker"
      );
    }

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

    if (deploymentResult.rows.length !== 1) {
      throw new Error(
        "Deployment associated with job was not found"
      );
    }

    const previousStatus = deploymentResult.rows[0].status as string;
    const safeMessage = errorMessage.slice(0, 4000);

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
          last_error = $3,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [jobId, backoffSeconds, safeMessage]
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
              error_code = 'DEPLOYMENT_RETRY',
              error_message = $2,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [deploymentId, safeMessage]
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
        last_error = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [jobId, safeMessage]
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
          error_code = 'DEPLOYMENT_FAILED',
          error_message = $2,
          finished_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [deploymentId, safeMessage]
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
