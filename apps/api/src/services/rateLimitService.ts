// PostgreSQL-backed fixed-window rate limiter for auth endpoints.
//
// Why PostgreSQL instead of memory: DeployKit already runs Postgres for the
// API, and an in-memory Map would silently reset per instance and grow
// without bounds. One row per (key, window), one atomic upsert per check,
// lazy expiry — no scans of live data, no background jobs. Approximate under
// concurrency (acceptable for throttling): the increment itself is atomic,
// so counts never lose writes.
//
// Buckets: per-IP over all attempts (credential stuffing across many emails)
// and per-account over consecutive failures (targeted guessing). Success
// clears the account bucket, so legitimate users are never permanently
// blocked. Checks run before user lookup, so 429s reveal nothing about
// account existence.

import pool from "../db/database.js";

export class RateLimitError extends Error {
  readonly code = "RATE_LIMITED";
  readonly status = 429;
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("Too many attempts");
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimitConfig {
  windowSeconds: number;
  ipMaxAttempts: number;
  emailMaxAttempts: number;
}

function readPositiveInteger(name: string, fallback: number, ceiling: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
    throw new Error(`${name} must be an integer between 1 and ${ceiling}`);
  }
  return value;
}

// Read per call (not cached) so tests and operators can adjust without
// restart-sensitive singletons; the parse cost is negligible next to I/O.
export function getRateLimitConfig(): RateLimitConfig {
  return {
    windowSeconds: readPositiveInteger("DEPLOYKIT_AUTH_RATE_LIMIT_WINDOW_SECONDS", 900, 86400),
    ipMaxAttempts: readPositiveInteger("DEPLOYKIT_AUTH_RATE_LIMIT_MAX_ATTEMPTS", 30, 10000),
    emailMaxAttempts: readPositiveInteger("DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS", 10, 1000),
  };
}

// Atomic consume-and-check. Returns retry delay only when denied.
async function consume(
  key: string,
  maxAttempts: number,
  windowSeconds: number
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const result = await pool.query(
    `
    INSERT INTO auth_rate_limits (key, window_start, count)
    VALUES ($1, NOW(), 1)
    ON CONFLICT (key) DO UPDATE SET
      window_start = CASE
        WHEN auth_rate_limits.window_start < NOW() - make_interval(secs => $2)
        THEN NOW()
        ELSE auth_rate_limits.window_start
      END,
      count = CASE
        WHEN auth_rate_limits.window_start < NOW() - make_interval(secs => $2)
        THEN 1
        ELSE auth_rate_limits.count + 1
      END
    RETURNING count, window_start
    `,
    [key, windowSeconds]
  );
  const row = result.rows[0] as { count: number; window_start: string };
  if (row.count <= maxAttempts) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const elapsed = (Date.now() - Date.parse(row.window_start)) / 1000;
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil(windowSeconds - elapsed)),
  };
}

export async function resetRateLimitKey(key: string): Promise<void> {
  await pool.query(`DELETE FROM auth_rate_limits WHERE key = $1`, [key]);
}

// Best-effort sweep of expired windows; failures must never block login.
export async function sweepExpiredRateLimits(windowSeconds: number): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM auth_rate_limits
       WHERE window_start < NOW() - make_interval(secs => $1)`,
      [windowSeconds]
    );
    return result.rowCount ?? 0;
  } catch {
    return 0;
  }
}

export function ipBucket(ip: string): string {
  return `login:ip:${ip || "unknown"}`;
}

export function emailBucket(prefix: string, email: string): string {
  return `${prefix}:email:${email}`;
}

// Throws RateLimitError when either bucket is exhausted. Callers set
// Retry-After from the error; the message stays generic by design.
export async function checkAuthRateLimit(input: {
  kind: "login" | "register";
  ip: string;
  email: string;
}): Promise<void> {
  const config = getRateLimitConfig();
  const ip = await consume(ipBucket(input.ip), config.ipMaxAttempts, config.windowSeconds);
  if (!ip.allowed) {
    throw new RateLimitError(ip.retryAfterSeconds);
  }
  const email = await consume(
    emailBucket(input.kind, input.email),
    config.emailMaxAttempts,
    config.windowSeconds
  );
  if (!email.allowed) {
    throw new RateLimitError(email.retryAfterSeconds);
  }
  await sweepExpiredRateLimits(config.windowSeconds);
}

export async function clearEmailRateLimit(kind: "login" | "register", email: string): Promise<void> {
  await resetRateLimitKey(emailBucket(kind, email));
}
