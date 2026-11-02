

import bcrypt from "bcryptjs";
import type { QueryResult } from "pg";
import pool from "../db/database.js";
import { withTransaction } from "../db/transaction.js";

export const BCRYPT_COST = 12;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 72;
export const MAX_EMAIL_LENGTH = 254;

export type UserRole = "admin" | "member";

export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export interface UserRow extends PublicUser {
  password_hash: string;
  disabled_at: string | null;
}

export interface AdminUserView {
  id: string;
  email: string;
  role: UserRole;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

const USER_COLUMNS = `id, email, role, disabled_at, created_at, updated_at`;

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

export function toPublicUser(row: UserRow | AdminUserView): PublicUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
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
    // The first account on a fresh server becomes the initial admin.
    return insertUserRow(client, { ...prepared, role: "admin" });
  });
}

interface QueryExecutor {
  query(queryText: string, values?: unknown[]): Promise<QueryResult>;
}

export async function prepareNewUser(
  email: unknown,
  password: unknown
): Promise<{ email: string; passwordHash: string }> {
  const normalized = validateEmail(normalizeEmail(email));
  const valid = validatePassword(password);
  return { email: normalized, passwordHash: await hashPassword(valid) };
}

export async function insertUserWithRole(
  db: QueryExecutor,
  prepared: { email: string; passwordHash: string; role?: UserRole }
): Promise<PublicUser> {
  return insertUserRow(db, prepared);
}

async function insertUserRow(
  db: QueryExecutor,
  prepared: { email: string; passwordHash: string; role?: UserRole }
): Promise<PublicUser> {
  try {
    const result = await db.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, email, role, disabled_at, created_at, updated_at`,
      [prepared.email, prepared.passwordHash, prepared.role ?? "member"]
    );
    return toPublicUser(result.rows[0] as UserRow);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new UserError("EMAIL_TAKEN", "Email already registered", 409);
    }
    throw error;
  }
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized) return null;
  const result = await pool.query(
    `SELECT ${USER_COLUMNS}, password_hash
     FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [normalized]
  );
  return (result.rows[0] as UserRow | undefined) ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  if (typeof id !== "string" || !id) return null;
  const result = await pool.query(
    `SELECT ${USER_COLUMNS}, password_hash
     FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return (result.rows[0] as UserRow | undefined) ?? null;
}

export async function hasAnyUsers(): Promise<boolean> {
  const result = await pool.query(`SELECT EXISTS(SELECT 1 FROM users) AS exists`);
  return result.rows[0].exists === true;
}

export function isDisabled(row: Pick<UserRow, "disabled_at">): boolean {
  return row.disabled_at !== null && row.disabled_at !== undefined;
}

export async function listUsers(): Promise<AdminUserView[]> {
  const result = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC, id ASC`
  );
  return result.rows as AdminUserView[];
}

export async function countActiveAdmins(): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND disabled_at IS NULL`
  );
  return result.rows[0]?.count ?? 0;
}

// Disabling is refused for the acting admin (self-lockout) and would never be
// allowed to drop the last enabled admin below one, so admin access cannot be
// accidentally revoked entirely.
export async function setUserDisabled(
  id: string,
  disabled: boolean,
  actingAdminId: string
): Promise<AdminUserView> {
  if (typeof id !== "string" || !id) {
    throw new UserError("INVALID_USER", "Invalid user", 400);
  }
  if (id === actingAdminId && disabled) {
    throw new UserError("CANNOT_DISABLE_SELF", "You cannot disable your own account", 400);
  }
  return withTransaction(async (client) => {
    const target = (
      await client.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [id])
    ).rows[0] as AdminUserView | undefined;
    if (!target) {
      throw new UserError("USER_NOT_FOUND", "User not found", 404);
    }
    if (disabled && target.role === "admin") {
      const admins = (
        await client.query(
          `SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND disabled_at IS NULL`
        )
      ).rows[0]?.count ?? 0;
      if (admins <= 1) {
        throw new UserError(
          "CANNOT_DISABLE_LAST_ADMIN",
          "Cannot disable the last active admin",
          400
        );
      }
    }
    const updated = (
      await client.query(
        `UPDATE users
         SET disabled_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING ${USER_COLUMNS}`,
        [id, disabled]
      )
    ).rows[0] as AdminUserView;
    return updated;
  });
}
