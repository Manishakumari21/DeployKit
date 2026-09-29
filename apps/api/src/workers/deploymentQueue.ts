import pool from "../db/database.js";

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

    const previousStatus = deploymentResult.rows[0].status;

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
        'cloning',
        $3,
        $4::jsonb
      )
      `,
      [
        claimed.deployment_id,
        previousStatus,
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
  } finally {
    client.release();
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

    await client.query(
      `
      UPDATE deployments
      SET
        status = 'active',
        finished_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND status = 'verifying'
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
        'verifying',
        'active',
        $2,
        $3::jsonb
      )
      `,
      [
        deploymentId,
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
        id,
        deployment_id,
        attempts,
        max_attempts
      FROM deployment_jobs
      WHERE
        status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= CURRENT_TIMESTAMP
      FOR UPDATE SKIP LOCKED
      `
    );

    for (const job of result.rows) {
      const exhausted = job.attempts >= job.max_attempts;

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

    const previousStatus = deploymentResult.rows[0].status;

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
        [jobId, backoffSeconds, errorMessage]
      );

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
        [deploymentId, errorMessage]
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
            error: errorMessage,
          }),
        ]
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
      [jobId, errorMessage]
    );

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
      [deploymentId, errorMessage]
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
          error: errorMessage,
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
