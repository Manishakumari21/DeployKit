import pool from "../db/database.js";
import { DomainError } from "../domains/domainName.js";
import {
  getDomainById,
  toDomainRow,
  type DomainRow,
  type TlsStatus,
} from "./domainService.js";

export class CertError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "CertError";
    this.code = code;
    this.status = status;
  }
}

export const RENEW_BEFORE_SECONDS = 30 * 24 * 60 * 60;
export const STUCK_RENEWING_SECONDS = 60 * 60;
export const MAX_ERROR_LENGTH = 500;

function boundError(message: string): string {
  return message.slice(0, MAX_ERROR_LENGTH);
}

export async function requestCertificate(domainId: string): Promise<DomainRow> {
  const current = await getDomainById(domainId);
  if (!current) {
    throw new DomainError("DOMAIN_NOT_FOUND", "Domain not found", 404);
  }
  if (current.status !== "verified") {
    throw new CertError("DOMAIN_UNVERIFIED", "Domain must be verified before requesting a certificate", 422);
  }
  if (current.tls_status === "pending" || current.tls_status === "renewing") {
    throw new CertError("CERT_REQUEST_ACTIVE", "A certificate request is already in progress", 409);
  }
  const next: TlsStatus = current.tls_status === "issued" ? "renewing" : "pending";
  const result = await pool.query(
    `
    UPDATE custom_domains
    SET tls_status = $2,
        tls_requested_at = CURRENT_TIMESTAMP,
        tls_last_error_code = NULL,
        tls_last_error = NULL
    WHERE id = $1
    RETURNING *
    `,
    [domainId, next]
  );
  return toDomainRow(result.rows[0]);
}


export async function claimDueCertificates(limit = 5): Promise<DomainRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('deploykit_cert_claim'))`
    );
    const due = await client.query(
      `
      SELECT *
      FROM custom_domains
      WHERE status = 'verified'
        AND (
          tls_status = 'pending'
          OR (
            tls_status = 'issued'
            AND cert_expires_at IS NOT NULL
            AND cert_expires_at < NOW() + make_interval(secs => $1)
          )
          OR (
            tls_status = 'renewing'
            AND (
              tls_last_attempt_at IS NULL
              OR tls_last_attempt_at < NOW() - make_interval(secs => $2)
            )
          )
        )
      ORDER BY tls_requested_at ASC NULLS LAST, cert_expires_at ASC NULLS FIRST
      LIMIT $3
      FOR UPDATE SKIP LOCKED
      `,
      [RENEW_BEFORE_SECONDS, STUCK_RENEWING_SECONDS, limit]
    );
    const claimed: DomainRow[] = [];
    for (const row of due.rows) {
      if (row.tls_status === "issued") {
        const moved = await client.query(
          `
          UPDATE custom_domains
          SET tls_status = 'renewing',
              tls_last_attempt_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND tls_status = 'issued'
          RETURNING *
          `,
          [row.id]
        );
        if (moved.rowCount === 1) claimed.push(toDomainRow(moved.rows[0]));
      } else {
        await client.query(
          `UPDATE custom_domains SET tls_last_attempt_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [row.id]
        );
        claimed.push(toDomainRow({ ...row, tls_last_attempt_at: new Date().toISOString() }));
      }
    }
    await client.query("COMMIT");
    return claimed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markCertificateIssued(input: {
  domainId: string;
  expectedTls: TlsStatus[];
  expiresAt: Date;
  certPath: string;
}): Promise<DomainRow> {
  const result = await pool.query(
    `
    UPDATE custom_domains
    SET tls_status = 'issued',
        cert_expires_at = $2,
        cert_path = $3,
        tls_last_error_code = NULL,
        tls_last_error = NULL
    WHERE id = $1 AND tls_status = ANY($4)
    RETURNING *
    `,
    [input.domainId, input.expiresAt.toISOString(), input.certPath, input.expectedTls]
  );
  if (result.rowCount === 0) {
    throw new CertError("CERT_STATE_CONFLICT", "Certificate state changed during issuance", 409);
  }
  return toDomainRow(result.rows[0]);
}

export async function markCertificateFailed(input: {
  domainId: string;
  code: string;
  message: string;
  revertToIssued: boolean;
}): Promise<DomainRow> {
  const next: TlsStatus = input.revertToIssued ? "issued" : "failed";
  const result = await pool.query(
    `
    UPDATE custom_domains
    SET tls_status = $2,
        tls_last_attempt_at = CURRENT_TIMESTAMP,
        tls_last_error_code = $3,
        tls_last_error = $4
    WHERE id = $1
    RETURNING *
    `,
    [input.domainId, next, input.code.slice(0, 100), boundError(input.message)]
  );
  if (result.rowCount === 0) {
    throw new DomainError("DOMAIN_NOT_FOUND", "Domain not found", 404);
  }
  return toDomainRow(result.rows[0]);
}

export async function markExpiredCertificates(): Promise<string[]> {
  const result = await pool.query(
    `
    UPDATE custom_domains
    SET tls_status = 'expired'
    WHERE tls_status IN ('issued', 'renewing', 'failed')
      AND cert_expires_at IS NOT NULL
      AND cert_expires_at < NOW()
    RETURNING project_id
    `
  );
  return [...new Set((result.rows as Array<{ project_id: string }>).map((r) => r.project_id))];
}

export async function countRenewalDue(): Promise<number> {
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS n FROM custom_domains
    WHERE status = 'verified'
      AND tls_status = 'issued'
      AND cert_expires_at IS NOT NULL
      AND cert_expires_at < NOW() + make_interval(secs => $1)
    `,
    [RENEW_BEFORE_SECONDS]
  );
  return result.rows[0].n as number;
}
