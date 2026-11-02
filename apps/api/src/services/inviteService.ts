import crypto from "node:crypto";
import type { QueryResult } from "pg";
import pool from "../db/database.js";
import { withTransaction } from "../db/transaction.js";
import { hashSecret } from "../security/tokenHasher.js";
import {
  normalizeEmail,
  validateEmail,
  type PublicUser,
  prepareNewUser,
  insertUserWithRole,
} from "./userService.js";

export const INVITE_TOKEN_BYTES = 32;

// Default invite lifetime; an unredeemed invite is a live credential, so it
// expires rather than lingering indefinitely.
const DEFAULT_INVITE_DAYS = 7;

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export interface InviteView {
  id: string;
  email: string;
  status: InviteStatus;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export class InviteError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "InviteError";
    this.code = code;
    this.status = status;
  }
}

interface QueryExecutor {
  query(queryText: string, values?: unknown[]): Promise<QueryResult>;
}

export function hashInviteToken(token: string): string {
  return hashSecret(token);
}

function inviteLifetimeDays(): number {
  const raw = process.env.DEPLOYKIT_INVITE_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_INVITE_DAYS;
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
    throw new Error("DEPLOYKIT_INVITE_DAYS must be an integer between 1 and 90");
  }
  return days;
}

function deriveStatus(row: {
  accepted_at: string | null;
  revoked_at: string | null;
  expires_at: string;
}): InviteStatus {
  if (row.accepted_at) return "accepted";
  if (row.revoked_at) return "revoked";
  if (new Date(row.expires_at).getTime() <= Date.now()) return "expired";
  return "pending";
}

function toInviteView(row: Record<string, unknown>): InviteView {
  const shaped = {
    accepted_at: row.accepted_at as string | null,
    revoked_at: row.revoked_at as string | null,
    expires_at: row.expires_at as string,
  };
  return {
    id: row.id as string,
    email: row.email as string,
    status: deriveStatus(shaped),
    invited_by: (row.invited_by as string | null) ?? null,
    created_at: row.created_at as string,
    expires_at: row.expires_at as string,
    accepted_at: row.accepted_at as string | null,
    revoked_at: row.revoked_at as string | null,
  };
}

export interface CreatedInvite {
  invite: InviteView;
  // The raw token is returned exactly once so the admin can share the link; it
  // is never stored (only its peppered hash is persisted).
  token: string;
}

export async function createInvite(
  email: unknown,
  invitedBy: string
): Promise<CreatedInvite> {
  const normalized = validateEmail(normalizeEmail(email));
  const token = crypto.randomBytes(INVITE_TOKEN_BYTES).toString("hex");
  const days = inviteLifetimeDays();
  try {
    const result = await pool.query(
      `INSERT INTO invites (email, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(days => $4))
       RETURNING id, email, invited_by, created_at, expires_at, accepted_at, revoked_at`,
      [normalized, hashInviteToken(token), invitedBy, days]
    );
    return { invite: toInviteView(result.rows[0]), token };
  } catch (error) {
    if (isDbCode(error, "23503")) {
      throw new InviteError("INVITER_NOT_FOUND", "Inviter not found", 404);
    }
    throw error;
  }
}

function isDbCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

export async function listInvites(): Promise<InviteView[]> {
  const result = await pool.query(
    `SELECT id, email, invited_by, created_at, expires_at, accepted_at, revoked_at
     FROM invites ORDER BY created_at DESC, id DESC`
  );
  return result.rows.map((row) => toInviteView(row));
}

export async function revokeInvite(id: string): Promise<InviteView> {
  if (typeof id !== "string" || !id) {
    throw new InviteError("INVALID_INVITE", "Invalid invite", 400);
  }
  const result = await pool.query(
    `UPDATE invites
     SET revoked_at = NOW()
     WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
     RETURNING id, email, invited_by, created_at, expires_at, accepted_at, revoked_at`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    // Distinguish "already consumed/revoked/expired" from "never existed".
    const existing = await pool.query(`SELECT 1 FROM invites WHERE id = $1`, [id]);
    if ((existing.rowCount ?? 0) === 0) {
      throw new InviteError("INVITE_NOT_FOUND", "Invite not found", 404);
    }
    throw new InviteError("INVITE_NOT_PENDING", "Invite is no longer pending", 409);
  }
  return toInviteView(row);
}

// A redeemed invite is single-use: the token row is claimed inside the same
// transaction that creates the user, guarded so two concurrent redemptions of
// the same token cannot both succeed.
export async function redeemInvite(input: {
  token: unknown;
  email: string;
  password: string;
}): Promise<PublicUser> {
  if (typeof input.token !== "string" || !input.token) {
    throw new InviteError("INVITE_REQUIRED", "A valid invite token is required", 403);
  }
  const prepared = await prepareNewUser(input.email, input.password);
  return withTransaction(async (client) => {
    const row = (
      await client.query(
        `SELECT id, email, accepted_at, revoked_at, expires_at
         FROM invites
         WHERE token_hash = $1
         FOR UPDATE`,
        [hashInviteToken(input.token as string)]
      )
    ).rows[0] as
      | { id: string; email: string; accepted_at: string | null; revoked_at: string | null; expires_at: string }
      | undefined;
    if (!row) {
      throw new InviteError("INVITE_INVALID", "This invite is not valid", 403);
    }
    if (row.accepted_at) {
      throw new InviteError("INVITE_USED", "This invite has already been used", 403);
    }
    if (row.revoked_at) {
      throw new InviteError("INVITE_REVOKED", "This invite was revoked", 403);
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new InviteError("INVITE_EXPIRED", "This invite has expired", 403);
    }
    // The invited email binds the account; a mismatch would let a leaked token
    // be redeemed by anyone, so the redeeming email must match the invite.
    if (prepared.email !== row.email.toLowerCase()) {
      throw new InviteError(
        "INVITE_EMAIL_MISMATCH",
        "This invite was issued for a different email address",
        403
      );
    }
    const user = await insertUserWithRole(client, { ...prepared, role: "member" });
    await client.query(
      `UPDATE invites
       SET accepted_at = NOW(), accepted_user_id = $2
       WHERE id = $1`,
      [row.id, user.id]
    );
    return user;
  });
}
