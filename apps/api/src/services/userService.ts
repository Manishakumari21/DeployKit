// Phase 10 Step 2: identity foundation — user creation and lookup only.
// No sessions, no login routes, no authorization here (later steps).
// Password hashing uses bcrypt (via bcryptjs, pure-JS, maintained) at cost 12.
// Controllers/routes are intentionally untouched in this step.

import bcrypt from "bcryptjs";
import type { QueryResult } from "pg";
import pool from "../db/database.js";
import { withTransaction } from "../db/transaction.js";

export const BCRYPT_COST = 12;
// bcrypt silently truncates inputs past 72 bytes, so longer passwords are
// rejected rather than hashed in a way that ignores the tail.
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 72;
export const MAX_EMAIL_LENGTH = 254;

export interface PublicUser {
  id: string;
  email: string;
  created_at: string;
  updated_at: string;
}

// Internal row including the hash. Required by the future login step for
// password verification. Never serialize this to an API response; use
// toPublicUser() at service boundaries.
export interface UserRow extends PublicUser {
  password_hash: string;
}

export class UserError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "UserError";
    this.code = code;
    this.status = status;
  }
}

// Trim + lowercase so 'User@Example.COM' and 'user@example.com' are one identity.
// Throws UserError on non-string/empty input; lookup helpers handle that.
export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new UserError("INVALID_EMAIL", "Invalid email address");
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new UserError("INVALID_EMAIL", "Invalid email address");
  }
  return normalized;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(normalized: string): string {
  if (
    typeof normalized !== "string" ||
    normalized.length < 3 ||
    normalized.length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(normalized)
  ) {
    throw new UserError("INVALID_EMAIL", "Invalid email address");
  }
  return normalized;
}

export function validatePassword(password: unknown): string {
  if (typeof password !== "string") {
    throw new UserError("WEAK_PASSWORD", "Password does not meet policy");
  }
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH ||
    password.trim().length === 0
  ) {
    throw new UserError("WEAK_PASSWORD", "Password does not meet policy");
  }
  return password;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (typeof password !== "string" || typeof hash !== "string") return false;
  return bcrypt.compare(password, hash);
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

export async function createUser(input: {
  email: string;
  password: string;
}): Promise<PublicUser> {
  const prepared = await prepareNewUser(input.email, input.password);
  return insertUserRow(pool, prepared);
}

// Bootstrap-gated creation for the empty-table first-user window. The
// emptiness re-check and the insert run in one transaction under a
// transactional advisory lock, so concurrent first registrations serialize:
// exactly one wins and the rest get REGISTRATION_CLOSED. An application-only
// COUNT(*) pre-check can never provide this; the lock is the mechanism.
// Expensive hashing happens before the lock is taken to hold it briefly.
export async function createBootstrapUser(input: {
  email: string;
  password: string;
}): Promise<PublicUser> {
  const prepared = await prepareNewUser(input.email, input.password);
  return withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('deploykit_registration_bootstrap'))`
    );
    const exists = (
      await client.query(`SELECT EXISTS(SELECT 1 FROM users) AS exists`)
    ).rows[0].exists;
    if (exists === true) {
      throw new UserError("REGISTRATION_CLOSED", "Public registration is disabled", 403);
    }
    return insertUserRow(client, prepared);
  });
}

// Minimal executor surface shared by pool and transaction clients, so the
// insert path is written once instead of per caller.
interface QueryExecutor {
  query(queryText: string, values?: unknown[]): Promise<QueryResult>;
}

async function prepareNewUser(
  email: unknown,
  password: unknown
): Promise<{ email: string; passwordHash: string }> {
  const normalized = validateEmail(normalizeEmail(email));
  const valid = validatePassword(password);
  return { email: normalized, passwordHash: await hashPassword(valid) };
}

async function insertUserRow(
  db: QueryExecutor,
  prepared: { email: string; passwordHash: string }
): Promise<PublicUser> {
  try {
    const result = await db.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, created_at, updated_at`,
      [prepared.email, prepared.passwordHash]
    );
    return result.rows[0] as PublicUser;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new UserError("EMAIL_TAKEN", "Email already registered", 409);
    }
    throw error;
  }
}

// Internal lookup for the future login step; includes password_hash.
// Returns null (never throws) for unknown or blank emails.
export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized) return null;
  const result = await pool.query(
    `SELECT id, email, password_hash, created_at, updated_at
     FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [normalized]
  );
  return (result.rows[0] as UserRow | undefined) ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  if (typeof id !== "string" || !id) return null;
  const result = await pool.query(
    `SELECT id, email, password_hash, created_at, updated_at
     FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return (result.rows[0] as UserRow | undefined) ?? null;
}

// True while no account exists at all. Backs the first-user bootstrap window:
// self-registration stays possible exactly until the first account is created.
export async function hasAnyUsers(): Promise<boolean> {
  const result = await pool.query(`SELECT EXISTS(SELECT 1 FROM users) AS exists`);
  return result.rows[0].exists === true;
}
