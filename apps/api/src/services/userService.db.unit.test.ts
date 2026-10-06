// Phase 10 Step 2: identity foundation tests (real PostgreSQL, no fakes).
// Pure validation tests always run; DB tests skip only if the users table
// (migration 011) has not been applied to the target database.
import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import {
  createUser,
  findUserByEmail,
  findUserById,
  hashPassword,
  normalizeEmail,
  toPublicUser,
  validateEmail,
  validatePassword,
  verifyPassword,
  UserError,
} from "./userService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.users') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

function uniqueEmail(tag: string): string {
  const rand = Math.floor(Math.random() * 1_000_000);
  return `phase10-${tag}-${Date.now()}-${rand}@example.com`;
}

const createdIds: string[] = [];

async function cleanup(): Promise<void> {
  if (createdIds.length === 0) return;
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [createdIds]);
  createdIds.length = 0;
}

// ---- Pure unit tests (no DB required) ----

test("normalizeEmail trims and lowercases consistently", () => {
  assert.equal(normalizeEmail("  User@Example.COM  "), "user@example.com");
  assert.equal(normalizeEmail("USER@EXAMPLE.COM"), "user@example.com");
  assert.throws(() => normalizeEmail(123), (e: unknown) => e instanceof UserError);
  assert.throws(() => normalizeEmail("   "), (e: unknown) => e instanceof UserError);
});

test("validateEmail rejects malformed addresses", () => {
  assert.equal(validateEmail("user@example.com"), "user@example.com");
  for (const bad of [
    "",
    "no-at-sign",
    "missing-domain@",
    "@missing-local.com",
    "spaces in@example.com",
    "user@nodot",
    `a@${"b".repeat(250)}.com`,
  ]) {
    assert.throws(() => validateEmail(bad), (e: unknown) => e instanceof UserError);
  }
});

test("validatePassword enforces the length policy", () => {
  assert.equal(validatePassword("long-enough-password"), "long-enough-password");
  for (const bad of ["", "short", "           ", "a".repeat(11), "b".repeat(73), 123, null]) {
    assert.throws(
      () => validatePassword(bad),
      (e: unknown) => e instanceof UserError && (e as UserError).code === "WEAK_PASSWORD"
    );
  }
});

// ---- Real database tests ----

test("valid user creation returns a public DTO without any hash", async () => {
  if (!(await dbAvailable())) return;
  const email = uniqueEmail("create");
  try {
    const user = await createUser({ email, password: "correct-horse-123" });
    createdIds.push(user.id);
    assert.match(user.id, /^[0-9a-f-]{36}$/);
    assert.equal(user.email, email.toLowerCase());
    assert.ok(user.created_at);
    assert.ok(user.updated_at);
    assert.ok(!("password_hash" in user), "public DTO must not contain password_hash");
  } finally {
    await cleanup();
  }
});

test("email is stored normalized", async () => {
  if (!(await dbAvailable())) return;
  const email = uniqueEmail("norm");
  const mixed = email.replace("@", "@").toUpperCase();
  try {
    const user = await createUser({ email: mixed, password: "correct-horse-123" });
    createdIds.push(user.id);
    assert.equal(user.email, email.toLowerCase());
    const raw = (
      await pool.query(`SELECT email FROM users WHERE id = $1`, [user.id])
    ).rows[0];
    assert.equal(raw.email, email.toLowerCase());
  } finally {
    await cleanup();
  }
});

test("duplicate email is rejected including case variants", async () => {
  if (!(await dbAvailable())) return;
  const email = uniqueEmail("dup");
  try {
    const user = await createUser({ email, password: "correct-horse-123" });
    createdIds.push(user.id);
    await assert.rejects(createUser({ email, password: "another-password-1" }), (e: unknown) => {
      return e instanceof UserError && e.code === "EMAIL_TAKEN" && e.status === 409;
    });
    await assert.rejects(
      createUser({ email: email.toUpperCase(), password: "another-password-1" }),
      (e: unknown) => e instanceof UserError && e.code === "EMAIL_TAKEN"
    );
  } finally {
    await cleanup();
  }
});

test("database enforces email uniqueness below the application layer", async () => {
  if (!(await dbAvailable())) return;
  const email = uniqueEmail("dbuniq");
  const hash = await hashPassword("correct-horse-123");
  const first = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, hash]
  );
  createdIds.push(first.rows[0].id);
  try {
    await assert.rejects(
      pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2)`, [
        email.toUpperCase(),
        hash,
      ]),
      (e: unknown) => (e as { code?: string }).code === "23505"
    );
    // A short plaintext value violates the password_hash length backstop.
    await assert.rejects(
      pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2)`, [
        uniqueEmail("plain"),
        "short",
      ]),
      (e: unknown) => (e as { code?: string }).code === "23514"
    );
  } finally {
    await cleanup();
  }
});

test("password is hashed with bcrypt and verifies correctly", async () => {
  if (!(await dbAvailable())) return;
  const email = uniqueEmail("hash");
  const password = "correct-horse-123";
  try {
    const user = await createUser({ email, password });
    createdIds.push(user.id);
    const raw = (
      await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [user.id])
    ).rows[0];
    assert.ok(typeof raw.password_hash === "string");
    assert.ok(!raw.password_hash.includes(password), "plaintext must never be stored");
    assert.match(raw.password_hash, /^\$2[aby]\$/);
    assert.equal(raw.password_hash.length, 60);
    assert.equal(await verifyPassword(password, raw.password_hash), true);
    assert.equal(await verifyPassword("wrong-password-xyz", raw.password_hash), false);
  } finally {
    await cleanup();
  }
});

test("invalid email and weak password are rejected without touching the DB", async () => {
  if (!(await dbAvailable())) return;
  await assert.rejects(
    createUser({ email: "not-an-email", password: "correct-horse-123" }),
    (e: unknown) => e instanceof UserError && e.code === "INVALID_EMAIL"
  );
  await assert.rejects(
    createUser({ email: uniqueEmail("weak"), password: "short" }),
    (e: unknown) => e instanceof UserError && e.code === "WEAK_PASSWORD"
  );
});

test("lookup by email is case-insensitive and by id works; unknown returns null", async () => {
  if (!(await dbAvailable())) return;
  const email = uniqueEmail("lookup");
  try {
    const created = await createUser({ email, password: "correct-horse-123" });
    createdIds.push(created.id);
    const byEmail = await findUserByEmail(email.toUpperCase());
    assert.ok(byEmail);
    assert.equal(byEmail.id, created.id);
    assert.equal(toPublicUser(byEmail).email, email.toLowerCase());
    assert.ok(!("password_hash" in toPublicUser(byEmail)));
    const byId = await findUserById(created.id);
    assert.ok(byId);
    assert.equal(byId.email, email.toLowerCase());
    assert.equal(await findUserByEmail(uniqueEmail("missing")), null);
  } finally {
    await cleanup();
  }
});
