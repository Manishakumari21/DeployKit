import test from "node:test";
import assert from "node:assert/strict";
import pool from "./database.js";
import {
  acquireAdvisoryXactLock,
  tryAcquireAdvisoryXactLock,
  deriveAdvisoryLockKey,
  ADVISORY_LOCK_NAMESPACES,
} from "./advisoryLock.js";
import { gateDb } from "../test/dbGate.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

test("deriveAdvisoryLockKey produces deterministic 64-bit signed integers", () => {
  const k1 = deriveAdvisoryLockKey("project", "proj-uuid-1234");
  const k2 = deriveAdvisoryLockKey("project", "proj-uuid-1234");
  const k3 = deriveAdvisoryLockKey("project", "proj-uuid-5678");
  const k4 = deriveAdvisoryLockKey("release", "proj-uuid-1234"); // same key, different namespace

  assert.equal(k1, k2, "identical namespace + key must produce identical lock key");
  assert.notEqual(k1, k3, "different keys must produce different lock keys");
  assert.notEqual(k1, k4, "different namespaces must produce different lock keys (domain separation)");

  // Verify key fits into signed 64-bit integer
  const big = BigInt(k1);
  assert.ok(big >= -9223372036854775808n && big <= 9223372036854775807n);
});

test("advisory locking: same-resource operations serialize, different-resource proceed independently", async () => {
  if (!(await gateDb("db/advisoryLock.db.unit.test.ts", dbAvailable))) return;

  const client1 = await pool.connect();
  const client2 = await pool.connect();

  const resourceA = `res-A-${Date.now()}`;
  const resourceB = `res-B-${Date.now()}`;
  const namespace = ADVISORY_LOCK_NAMESPACES.PROJECT_DEPLOYMENT;

  try {
    await client1.query("BEGIN");
    await client2.query("BEGIN");

    // 1. Client 1 acquires lock on Resource A
    await acquireAdvisoryXactLock(client1, namespace, resourceA);

    // 2. Client 2 attempts to acquire lock on Resource A -> must fail because Client 1 holds it
    const acquiredSame = await tryAcquireAdvisoryXactLock(client2, namespace, resourceA);
    assert.equal(acquiredSame, false, "Same-resource operations must serialize (lock cannot be acquired concurrently)");

    // 3. Client 2 acquires lock on Resource B -> must succeed independently
    const acquiredDiff = await tryAcquireAdvisoryXactLock(client2, namespace, resourceB);
    assert.equal(acquiredDiff, true, "Different-resource operations must proceed independently without contention");

    // 4. Client 1 commits transaction -> releasing lock on Resource A
    await client1.query("COMMIT");

    // 5. Client 2 now attempts to acquire lock on Resource A -> must now succeed!
    const acquiredAfterCommit = await tryAcquireAdvisoryXactLock(client2, namespace, resourceA);
    assert.equal(acquiredAfterCommit, true, "Lock must be released automatically after transaction completion");

    await client2.query("COMMIT");
  } finally {
    try {
      await client1.query("ROLLBACK");
    } catch {}
    try {
      await client2.query("ROLLBACK");
    } catch {}
    client1.release();
    client2.release();
  }
});

test("advisory locking: failure paths (rollback) do not leave locks held", async () => {
  if (!(await gateDb("db/advisoryLock.db.unit.test.ts", dbAvailable))) return;

  const client1 = await pool.connect();
  const client2 = await pool.connect();

  const resource = `res-fail-${Date.now()}`;
  const namespace = ADVISORY_LOCK_NAMESPACES.WEBHOOK_DELIVERY;

  try {
    await client1.query("BEGIN");
    await acquireAdvisoryXactLock(client1, namespace, resource);

    // Simulate an error and abortive ROLLBACK in client 1
    await client1.query("ROLLBACK");

    // Client 2 in a new transaction must immediately be able to acquire the lock
    await client2.query("BEGIN");
    const acquiredAfterRollback = await tryAcquireAdvisoryXactLock(client2, namespace, resource);
    assert.equal(acquiredAfterRollback, true, "Failure/rollback must not leave locks held");
    await client2.query("COMMIT");
  } finally {
    try {
      await client1.query("ROLLBACK");
    } catch {}
    try {
      await client2.query("ROLLBACK");
    } catch {}
    client1.release();
    client2.release();
  }
});
