// Phase 10 Step 4: session lifecycle against real PostgreSQL.
// Raw tokens must never be recoverable from the database.
import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import { createUser } from "./userService.js";
import {
  createSession,
  deleteExpiredSessions,
  hashSessionToken,
  resolveSession,
  revokeSession,
  revokeSessionById,
  SessionError,
} from "./sessionService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.sessions') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

function uniqueEmail(tag: string): string {
  const rand = Math.floor(Math.random() * 1_000_000);
  return `phase10-sess-${tag}-${Date.now()}-${rand}@example.com`;
}

const userIds: string[] = [];

async function makeUser(tag: string) {
  const user = await createUser({ email: uniqueEmail(tag), password: "correct-horse-123" });
  userIds.push(user.id);
  return user;
}

async function cleanup(): Promise<void> {
  if (userIds.length > 0) {
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
    userIds.length = 0;
  }
}

test("creates a session with a 256-bit hex token and ~7d expiry", async () => {
  if (!(await dbAvailable())) return;
  const user = await makeUser("create");
  try {
    const session = await createSession(user.id);
    assert.match(session.id, /^[0-9a-f-]{36}$/);
    assert.equal(session.userId, user.id);
    assert.match(session.token, /^[0-9a-f]{64}$/);
    const expiresIn = Date.parse(session.expiresAt) - Date.now();
    assert.ok(expiresIn > 6 * 24 * 3600 * 1000 && expiresIn <= 7 * 24 * 3600 * 1000);
  } finally {
    await cleanup();
  }
});

test("raw token is stored only as a SHA-256 digest", async () => {
  if (!(await dbAvailable())) return;
  const user = await makeUser("digest");
  try {
    const session = await createSession(user.id);
    const raw = (
      await pool.query(`SELECT token_hash FROM sessions WHERE id = $1`, [session.id])
    ).rows[0];
    assert.ok(!raw.token_hash.includes(session.token));
    assert.equal(raw.token_hash, hashSessionToken(session.token));
    assert.match(raw.token_hash, /^[0-9a-f]{64}$/);
  } finally {
    await cleanup();
  }
});

test("valid session resolves to the correct user", async () => {
  if (!(await dbAvailable())) return;
  const user = await makeUser("resolve");
  try {
    const session = await createSession(user.id);
    const resolved = await resolveSession(session.token);
    assert.ok(resolved);
    assert.equal(resolved.userId, user.id);
    assert.equal(resolved.sessionId, session.id);
  } finally {
    await cleanup();
  }
});

test("unknown, malformed, and empty tokens resolve to null", async () => {
  if (!(await dbAvailable())) return;
  assert.equal(await resolveSession("0".repeat(64)), null);
  assert.equal(await resolveSession("not-a-token"), null);
  assert.equal(await resolveSession(""), null);
  assert.equal(await resolveSession(null), null);
  assert.equal(await resolveSession(undefined), null);
});

test("expired sessions are rejected", async () => {
  if (!(await dbAvailable())) return;
  const user = await makeUser("expired");
  try {
    const session = await createSession(user.id);
    await pool.query(`UPDATE sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
      session.id,
    ]);
    assert.equal(await resolveSession(session.token), null);
  } finally {
    await cleanup();
  }
});

test("revoked sessions are rejected and revocation is idempotent", async () => {
  if (!(await dbAvailable())) return;
  const user = await makeUser("revoke");
  try {
    const session = await createSession(user.id);
    assert.equal(await revokeSession(session.token), true);
    assert.equal(await resolveSession(session.token), null);
    assert.equal(await revokeSession(session.token), false);
    assert.equal(await revokeSession("0".repeat(64)), false);
  } finally {
    await cleanup();
  }
});

test("revokeSessionById invalidates without the token", async () => {
  if (!(await dbAvailable())) return;
  const user = await makeUser("byid");
  try {
    const session = await createSession(user.id);
    assert.equal(await revokeSessionById(session.id), true);
    assert.equal(await resolveSession(session.token), null);
    assert.equal(await revokeSessionById(session.id), false);
  } finally {
    await cleanup();
  }
});

test("deleting a user cascades their sessions", async () => {
  if (!(await dbAvailable())) return;
  const user = await makeUser("cascade");
  const session = await createSession(user.id);
  await pool.query(`DELETE FROM users WHERE id = $1`, [user.id]);
  userIds.length = 0;
  const remaining = (
    await pool.query(`SELECT COUNT(*)::int AS n FROM sessions WHERE id = $1`, [session.id])
  ).rows[0].n;
  assert.equal(remaining, 0);
  assert.equal(await resolveSession(session.token), null);
});

test("deleteExpiredSessions removes only expired rows", async () => {
  if (!(await dbAvailable())) return;
  const user = await makeUser("sweep");
  try {
    const live = await createSession(user.id);
    const dead = await createSession(user.id);
    await pool.query(`UPDATE sessions SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [
      dead.id,
    ]);
    const deleted = await deleteExpiredSessions();
    assert.ok(deleted >= 1);
    assert.ok(await resolveSession(live.token));
    assert.equal(await resolveSession(dead.token), null);
  } finally {
    await cleanup();
  }
});

test("sessions cannot be created for unknown users", async () => {
  if (!(await dbAvailable())) return;
  const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM sessions`)).rows[0].n;
  await assert.rejects(
    createSession("00000000-0000-0000-0000-000000000000"),
    (e: unknown) => e instanceof SessionError
  );
  await assert.rejects(createSession(""), (e: unknown) => e instanceof SessionError);
  const after = (await pool.query(`SELECT COUNT(*)::int AS n FROM sessions`)).rows[0].n;
  assert.equal(after, before);
});
