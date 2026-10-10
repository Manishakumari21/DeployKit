

import crypto from "node:crypto";
import pool from "../db/database.js";
import { getSessionLifetimeMs } from "../config/sessionConfig.js";

export const SESSION_TOKEN_BYTES = 32;

export class SessionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.status = status;
  }
}

export interface CreatedSession {
  id: string;
  userId: string;
  expiresAt: string;

  token: string;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function isDbCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

export async function createSession(userId: string): Promise<CreatedSession> {
  if (typeof userId !== "string" || !userId) {
    throw new SessionError("INVALID_USER", "Invalid user id");
  }
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("hex");
  const lifetimeMs = getSessionLifetimeMs();
  try {
    const result = await pool.query(
      `
      INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, NOW() + make_interval(secs => $3))
      RETURNING id, user_id, expires_at
      `,
      [hashSessionToken(token), userId, lifetimeMs / 1000]
    );
    const row = result.rows[0] as { id: string; user_id: string; expires_at: string };
    return { id: row.id, userId: row.user_id, expiresAt: row.expires_at, token };
  } catch (error) {
    if (isDbCode(error, "23503")) {
      throw new SessionError("USER_NOT_FOUND", "User not found", 404);
    }
    if (isDbCode(error, "22P02")) {
      throw new SessionError("INVALID_USER", "Invalid user id");
    }
    throw error;
  }
}

export async function resolveSession(token: unknown): Promise<ResolvedSession | null> {
  if (typeof token !== "string" || !token) return null;
  const result = await pool.query(
    `
    SELECT id, user_id
    FROM sessions
    WHERE token_hash = $1
      AND revoked_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
    `,
    [hashSessionToken(token)]
  );
  const row = result.rows[0] as { id: string; user_id: string } | undefined;
  if (!row) return null;
  return { sessionId: row.id, userId: row.user_id };
}

export async function revokeSession(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !token) return false;
  const result = await pool.query(
    `
    UPDATE sessions
    SET revoked_at = NOW()
    WHERE token_hash = $1 AND revoked_at IS NULL
    `,
    [hashSessionToken(token)]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeSessionById(sessionId: string): Promise<boolean> {
  if (typeof sessionId !== "string" || !sessionId) return false;
  const result = await pool.query(
    `
    UPDATE sessions
    SET revoked_at = NOW()
    WHERE id = $1 AND revoked_at IS NULL
    `,
    [sessionId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteExpiredSessions(): Promise<number> {
  const result = await pool.query(`DELETE FROM sessions WHERE expires_at < NOW()`);
  return result.rowCount ?? 0;
}
