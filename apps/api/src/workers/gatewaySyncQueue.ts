import { randomUUID } from "node:crypto";
import pool from "../db/database.js";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 10_000;

export interface GatewaySyncRequest {
  id: string;
  projectId: string;
  reason: string;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
}

export interface EnqueueResult {
  id: string;
  coalesced: boolean;
}

export async function enqueueGatewaySync(
  projectId: string,
  reason: string,
  maxAttempts = DEFAULT_MAX_ATTEMPTS
): Promise<EnqueueResult> {
  const result = await pool.query(
    `
    INSERT INTO gateway_sync_requests (project_id, reason, status, attempts, max_attempts)
    VALUES ($1, $2, 'pending', 0, $3)
    ON CONFLICT (project_id) WHERE status = 'pending'
    DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS inserted
    `,
    [projectId, reason, maxAttempts]
  );
  const row = result.rows[0] as { id: string; inserted: boolean } | undefined;
  return {
    id: row?.id ?? "",
    coalesced: row ? !row.inserted : false,
  };
}

export async function claimNextGatewaySyncJob(
  workerId: string,
  leaseMs = DEFAULT_LEASE_MS
): Promise<GatewaySyncRequest | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `
      SELECT id, project_id, reason, attempts, max_attempts
      FROM gateway_sync_requests
      WHERE status = 'pending'
        AND available_at <= CURRENT_TIMESTAMP
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
      `
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = result.rows[0] as {
      id: string;
      project_id: string;
      reason: string;
      attempts: number;
      max_attempts: number;
    };
    const leaseToken = randomUUID();
    await client.query(
      `
      UPDATE gateway_sync_requests
      SET status = 'running',
          attempts = attempts + 1,
          locked_at = CURRENT_TIMESTAMP,
          locked_by = $2,
          lease_expires_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond'),
          lease_token = $4,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [row.id, workerId, leaseMs, leaseToken]
    );
    await client.query("COMMIT");
    return {
      id: row.id,
      projectId: row.project_id,
      reason: row.reason,
      attempts: row.attempts + 1,
      maxAttempts: row.max_attempts,
      leaseToken,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeGatewaySyncJob(
  id: string,
  workerId: string,
  leaseToken: string
): Promise<boolean> {
  const result = await pool.query(
    `
    UPDATE gateway_sync_requests
    SET status = 'done',
        locked_at = NULL,
        locked_by = NULL,
        lease_expires_at = NULL,
        lease_token = NULL,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
      AND status = 'running'
      AND locked_by = $2
      AND lease_token = $3
    `,
    [id, workerId, leaseToken]
  );
  return result.rowCount === 1;
}

export async function failGatewaySyncJob(
  id: string,
  workerId: string,
  leaseToken: string,
  errorMessage: string
): Promise<"retrying" | "failed" | "lost"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query(
      `
      SELECT attempts, max_attempts
      FROM gateway_sync_requests
      WHERE id = $1 AND status = 'running' AND locked_by = $2 AND lease_token = $3
      FOR UPDATE
      `,
      [id, workerId, leaseToken]
    );
    if (row.rowCount !== 1) {
      await client.query("ROLLBACK");
      return "lost";
    }
    const current = row.rows[0] as { attempts: number; max_attempts: number };
    const safeMessage = errorMessage.slice(0, 4000);
    if (current.attempts >= current.max_attempts) {
      await client.query(
        `
        UPDATE gateway_sync_requests
        SET status = 'failed',
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            lease_token = NULL,
            last_error = $2,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [id, safeMessage]
      );
      await client.query("COMMIT");
      return "failed";
    }
    await client.query(
      `
      UPDATE gateway_sync_requests
      SET status = 'pending',
          available_at = CURRENT_TIMESTAMP + ($2 * INTERVAL '1 millisecond'),
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          lease_token = NULL,
          last_error = $3,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [id, RETRY_BACKOFF_MS, safeMessage]
    );
    await client.query("COMMIT");
    return "retrying";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverExpiredGatewaySyncJobs(): Promise<number> {
  const result = await pool.query(
    `
    UPDATE gateway_sync_requests
    SET status = 'pending',
        available_at = CURRENT_TIMESTAMP,
        locked_at = NULL,
        locked_by = NULL,
        lease_expires_at = NULL,
        lease_token = NULL,
        last_error = 'Gateway sync lease expired; job recovered',
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= CURRENT_TIMESTAMP
    `
  );
  return result.rowCount ?? 0;
}

export async function pendingGatewaySyncCount(): Promise<number> {
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS n
    FROM gateway_sync_requests
    WHERE status IN ('pending', 'running')
    `
  );
  return result.rows[0]?.n ?? 0;
}
