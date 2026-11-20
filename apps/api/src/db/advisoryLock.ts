import crypto from "node:crypto";
import type { PoolClient } from "pg";

/**
 * Deterministically derives a 64-bit signed integer (bigint) string from a namespace and key
 * using SHA-256 truncated to 8 bytes Big-Endian.
 *
 * This provides collision-resistant locking with a 2^64 keyspace (~1.84 x 10^19),
 * completely eliminating the 32-bit hashtext() collision vulnerabilities.
 */
export function deriveAdvisoryLockKey(namespace: string, key: string = ""): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${namespace}:${key}`, "utf8")
    .digest();
  return hash.readBigInt64BE(0).toString();
}

/**
 * Namespace constants ensuring domain separation across platform lock types.
 */
export const ADVISORY_LOCK_NAMESPACES = {
  PROJECT_DEPLOYMENT: "deploykit:project_deployment",
  PROJECT_ACTIVE_RELEASE: "deploykit:project_active_release",
  RUNTIME_CONTAINER_RECORD: "deploykit:runtime_container_record",
  WEBHOOK_DELIVERY: "deploykit:webhook_delivery",
  REGISTRATION_BOOTSTRAP: "deploykit:registration_bootstrap",
  CERT_CLAIM: "deploykit:cert_claim",
  DEPLOYMENT_LOG_INGESTION: "deploykit:deployment_log_ingestion",
} as const;

/**
 * Acquires a transaction-level advisory lock using a collision-resistant 64-bit key.
 * The lock is automatically released by PostgreSQL when the surrounding transaction commits or rolls back.
 */
export async function acquireAdvisoryXactLock(
  client: PoolClient,
  namespace: string,
  key: string = ""
): Promise<void> {
  const lockKey = deriveAdvisoryLockKey(namespace, key);
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockKey]);
}

/**
 * Attempts to acquire a transaction-level advisory lock without blocking.
 * Returns true if the lock was acquired, false if held by another transaction.
 */
export async function tryAcquireAdvisoryXactLock(
  client: PoolClient,
  namespace: string,
  key: string = ""
): Promise<boolean> {
  const lockKey = deriveAdvisoryLockKey(namespace, key);
  const result = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
    [lockKey]
  );
  return result.rows[0]?.acquired === true;
}
