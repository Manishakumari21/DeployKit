// Phase 11.1–11.3: custom-domain data operations (verification only, no TLS).
// PostgreSQL is authoritative; gateway files are a derived projection built
// elsewhere from getVerifiedDomains(). Raw verification tokens are returned
// exactly once (creation / expiry rotation) and never logged or persisted:
// only the SHA-256 digest is stored.

import crypto from "node:crypto";
import { promises as dns } from "node:dns";
import pool from "../db/database.js";
import { normalizeDomain } from "../domains/domainName.js";
import { DomainError } from "../domains/domainName.js";

export type DomainStatus =
  | "pending"
  | "verifying"
  | "verified"
  | "failed"
  | "removed";

export type TlsStatus =
  | "none"
  | "pending"
  | "issued"
  | "renewing"
  | "failed"
  | "expired";

export interface DomainRow {
  id: string;
  project_id: string;
  domain: string;
  status: DomainStatus;
  verification_token_hash: string;
  verified_at: string | null;
  verification_expires_at: string | null;
  tls_status: TlsStatus;
  cert_expires_at: string | null;
  cert_path: string | null;
  tls_requested_at: string | null;
  tls_last_attempt_at: string | null;
  tls_last_error_code: string | null;
  tls_last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatedDomain {
  row: DomainRow;
  verificationToken: string;
}

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const DNS_TIMEOUT_MS = 5000;

export function hashVerificationToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

export function toDomainRow(raw: Record<string, unknown>): DomainRow {
  return {
    id: raw.id as string,
    project_id: raw.project_id as string,
    domain: raw.domain as string,
    status: raw.status as DomainStatus,
    verification_token_hash: raw.verification_token_hash as string,
    verified_at: (raw.verified_at as string | null) ?? null,
    verification_expires_at:
      (raw.verification_expires_at as string | null) ?? null,
    tls_status: (raw.tls_status as TlsStatus) ?? "none",
    cert_expires_at: (raw.cert_expires_at as string | null) ?? null,
    cert_path: (raw.cert_path as string | null) ?? null,
    tls_requested_at: (raw.tls_requested_at as string | null) ?? null,
    tls_last_attempt_at: (raw.tls_last_attempt_at as string | null) ?? null,
    tls_last_error_code: (raw.tls_last_error_code as string | null) ?? null,
    tls_last_error: (raw.tls_last_error as string | null) ?? null,
    created_at: raw.created_at as string,
    updated_at: raw.updated_at as string,
  };
}

// Single-query listing for a project (no N+1). Ordered by creation.
export async function listDomains(projectId: string): Promise<DomainRow[]> {
  const result = await pool.query(
    `
    SELECT *
    FROM custom_domains
    WHERE project_id = $1
    ORDER BY created_at ASC
    `,
    [projectId]
  );
  return result.rows.map(toDomainRow);
}

// Verified hostnames only, for the gateway renderer. One query, no N+1.
export async function getVerifiedDomains(
  projectId: string
): Promise<string[]> {
  const result = await pool.query(
    `
    SELECT domain
    FROM custom_domains
    WHERE project_id = $1 AND status = 'verified'
    ORDER BY domain ASC
    `,
    [projectId]
  );
  return result.rows.map((r: { domain: string }) => r.domain);
}

export async function getDomainById(id: string): Promise<DomainRow | null> {
  if (!id) return null;
  const result = await pool.query(
    `SELECT * FROM custom_domains WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (result.rowCount === 0) return null;
  return toDomainRow(result.rows[0]);
}

// Direct insert is authoritative for uniqueness: no SELECT-then-INSERT.
// A 23505 conflict (including case variants via lower(domain)) maps to 409.
export async function createDomain(input: {
  projectId: string;
  domain: string;
}): Promise<CreatedDomain> {
  const normalized = normalizeDomain(input.domain);
  const token = crypto.randomBytes(32).toString("hex");
  try {
    const result = await pool.query(
      `
      INSERT INTO custom_domains (
        project_id, domain, status,
        verification_token_hash, verification_expires_at
      )
      VALUES ($1, $2, 'pending', $3, NOW() + make_interval(secs => $4))
      RETURNING *
      `,
      [input.projectId, normalized, hashVerificationToken(token), VERIFICATION_TTL_MS / 1000]
    );
    return { row: toDomainRow(result.rows[0]), verificationToken: token };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DomainError("DOMAIN_TAKEN", "Domain already belongs to another project", 409);
    }
    // Missing project FK surfaces as 23503 — report as not found, not 500.
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "23503"
    ) {
      throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    }
    throw error;
  }
}

export type TxtLookup = (hostname: string) => Promise<string[][]>;

async function defaultLookupTxt(hostname: string): Promise<string[][]> {
  const started = Date.now();
  const lookup = dns.resolveTxt(hostname);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_TIMEOUT_MS);
  });
  const records = await Promise.race([lookup, timeout]);
  void started;
  return records;
}

function candidateMatches(candidate: string, storedHash: string): boolean {
  const candidateHash = hashVerificationToken(candidate.trim());
  const a = Buffer.from(candidateHash, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// pending → verifying → verified | failed. Never marks verified from HTTP
// reachability or CNAME alone — only an exact DNS TXT token match.
// Expired verification rotates the token (invalidating the previous one)
// and reports VERIFICATION_EXPIRED so the owner fetches the new challenge.
export async function verifyDomain(
  domainId: string,
  options: { lookupTxt?: TxtLookup } = {}
): Promise<{ row: DomainRow; rotated?: CreatedDomain }> {
  const current = await getDomainById(domainId);
  if (!current) {
    throw new DomainError("DOMAIN_NOT_FOUND", "Domain not found", 404);
  }
  if (current.status === "verified") {
    return { row: current };
  }
  if (current.status === "removed") {
    throw new DomainError("DOMAIN_NOT_FOUND", "Domain not found", 404);
  }
  // Expiry check first: rotation invalidates the previous token. The new
  // raw token is returned via `rotated` so the owner can update DNS.
  if (
    current.verification_expires_at &&
    Date.parse(current.verification_expires_at) <= Date.now()
  ) {
    const token = crypto.randomBytes(32).toString("hex");
    const rotated = await pool.query(
      `
      UPDATE custom_domains
      SET verification_token_hash = $2,
          verification_expires_at = NOW() + make_interval(secs => $3),
          status = 'pending',
          verified_at = NULL
      WHERE id = $1
      RETURNING *
      `,
      [domainId, hashVerificationToken(token), VERIFICATION_TTL_MS / 1000]
    );
    const err = new DomainError(
      "VERIFICATION_EXPIRED",
      "Verification expired; a new token was issued"
    );
    (err as unknown as { status: number }).status = 410;
    (err as unknown as { rotated: CreatedDomain }).rotated = {
      row: toDomainRow(rotated.rows[0]),
      verificationToken: token,
    };
    throw err;
  }

  await pool.query(
    `UPDATE custom_domains SET status = 'verifying' WHERE id = $1`,
    [domainId]
  );

  const lookup = options.lookupTxt ?? defaultLookupTxt;
  const hostname = `_deploykit-challenge.${current.domain}`;
  let records: string[][];
  try {
    records = await lookup(hostname);
  } catch {
    await pool.query(
      `UPDATE custom_domains SET status = 'failed' WHERE id = $1`,
      [domainId]
    );
    throw new DomainError("VERIFICATION_FAILED", "DNS verification failed", 422);
  }
  // Each TXT record may arrive chunked — join chunks before comparing.
  const candidates: string[] = [];
  for (const record of records ?? []) {
    if (Array.isArray(record)) candidates.push(record.join(""));
    else if (typeof record === "string") candidates.push(record);
  }
  const ok = candidates.some((c) => candidateMatches(c, current.verification_token_hash));
  if (!ok) {
    await pool.query(
      `UPDATE custom_domains SET status = 'failed' WHERE id = $1`,
      [domainId]
    );
    throw new DomainError("VERIFICATION_FAILED", "DNS verification failed", 422);
  }
  const result = await pool.query(
    `
    UPDATE custom_domains
    SET status = 'verified', verified_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *
    `,
    [domainId]
  );
  return { row: toDomainRow(result.rows[0]) };
}

// Hard delete after the caller has converged the gateway projection.
// Returns the deleted row, or null when already absent (idempotent check
// lives in the controller: missing → 404, stable across retries).
export async function deleteDomainRow(domainId: string): Promise<DomainRow | null> {
  const result = await pool.query(
    `DELETE FROM custom_domains WHERE id = $1 RETURNING *`,
    [domainId]
  );
  if (result.rowCount === 0) return null;
  return toDomainRow(result.rows[0]);
}
