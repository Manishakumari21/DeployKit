import pool from "../db/database.js";
import { withTransaction } from "../db/transaction.js";
import { redactForLog } from "../agents/edgeJobSchema.js";
import type { PoolClient } from "pg";

// Error Intelligence (Phase 3): detectors observe existing failure signals
// (deployments, runtime instances, gateway sync queue, custom domain TLS,
// GitHub webhook deliveries) and maintain one open incident per failing
// subject. Design invariants:
//
//   1. Idempotent upserts — a repeated sweep with the same signal token never
//      increments occurrence_count; a changed token is a new signal and
//      counts exactly once even if the sweep retries.
//   2. Guarded transitions — acknowledge/resolve run inside a transaction with
//      row locks; invalid transitions throw IncidentStateError (API 409).
//   3. Auto-resolve only on verified recovery read from the source table at
//      resolve time. Deployment failures are manual-resolve only.
//   4. Recurrence after a resolved incident creates a NEW incident row; the
//      resolved history is never rewritten.
//   5. Evidence older than a resolution (by source timestamp) never reopens
//      or overrides the recovery.
//   6. Webhook incidents are attributed only to a reliably identified
//      project (via the delivery's deployment, or a repository linked to
//      exactly one project). Unmatchable deliveries are skipped.
//   7. All queries are bounded; evidence strings are redacted and clipped.

export type IncidentKind =
  | "deployment_failure"
  | "runtime_unhealthy"
  | "gateway_sync_failed"
  | "tls_failure"
  | "webhook_failed";

export const INCIDENT_KINDS: readonly IncidentKind[] = [
  "deployment_failure",
  "runtime_unhealthy",
  "gateway_sync_failed",
  "tls_failure",
  "webhook_failed",
];

export type IncidentStatus = "open" | "acknowledged" | "resolved";
export type IncidentSeverity = "warning" | "critical";

export interface Incident {
  id: string;
  project_id: string;
  kind: IncidentKind;
  subject_key: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  title: string;
  detail: string | null;
  error_code: string | null;
  evidence: Record<string, unknown>;
  signal_token: string | null;
  source_timestamp: string | null;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolution: "manual" | "auto" | null;
  created_at: string;
  updated_at: string;
}

export class IncidentNotFoundError extends Error {
  constructor() {
    super("Incident not found");
    this.name = "IncidentNotFoundError";
  }
}

export class IncidentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentStateError";
  }
}

/** A failure signal produced by a detector. */
export interface IncidentCandidate {
  projectId: string;
  kind: IncidentKind;
  subjectKey: string;
  severity: IncidentSeverity;
  title: string;
  detail: string | null;
  errorCode: string | null;
  evidence: Record<string, unknown>;
  /** Stable identity of this signal; unchanged tokens are idempotent. */
  signalToken: string;
  /** Timestamp from the source row; guards against stale reopens. */
  sourceTimestamp: Date;
}

const MAX_TITLE = 200;
const MAX_DETAIL = 1000;
const MAX_ERROR_CODE = 100;
const MAX_EVIDENCE_STRING = 500;
const MAX_EVIDENCE_ENTRIES = 16;
const DETECTOR_ROW_LIMIT = 100;
const RECOVERY_ROW_LIMIT = 200;

function clip(value: string, max: number): string {
  const redacted = redactForLog(value);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

function clipOrNull(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value === "") return null;
  return clip(value, max);
}

/**
 * Bounded + redacted evidence snapshot. Never throws; unknown shapes are
 * replaced with a marker rather than passed through raw.
 */
export function sanitizeEvidence(
  input: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= MAX_EVIDENCE_ENTRIES) break;
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      out[key] = clip(value, MAX_EVIDENCE_STRING);
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value instanceof Date
    ) {
      out[key] = value;
    } else {
      out[key] = `[${typeof value}]`;
    }
    count += 1;
  }
  return out;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(fn);
}

// ---------------------------------------------------------------------------
// Persistence (single writer: the worker sweep; transitions: HTTP handlers)
// ---------------------------------------------------------------------------

export type PersistOutcome =
  | { outcome: "created"; incident: Incident }
  | { outcome: "updated"; incident: Incident }
  | { outcome: "touched"; incident: Incident }
  | { outcome: "skipped"; reason: string };

/**
 * Idempotent upsert of one candidate signal.
 *
 * - Open incident, same token  -> touch last_seen_at only (no count bump).
 * - Open incident, new token   -> occurrence_count + 1 exactly once.
 * - No open incident, no resolved history -> create (count 1).
 * - Resolved history:
 *     - candidate source timestamp is NEWER than the resolution -> create a
 *       new incident (recurrence; resolved rows are never touched).
 *     - otherwise -> skip (stale evidence must not override a recovery).
 */
export async function persistCandidate(
  candidate: IncidentCandidate
): Promise<PersistOutcome> {
  const title = clip(candidate.title, MAX_TITLE);
  const detail = clipOrNull(candidate.detail, MAX_DETAIL);
  const errorCode = clipOrNull(candidate.errorCode, MAX_ERROR_CODE);
  const evidence = sanitizeEvidence(candidate.evidence);
  const sourceTimestamp = candidate.sourceTimestamp;

  const run = (): Promise<PersistOutcome> =>
    tx(async (client) => {
      const open = await client.query(
        `SELECT id FROM incidents
         WHERE project_id = $1 AND subject_key = $2 AND status <> 'resolved'
         FOR UPDATE`,
        [candidate.projectId, candidate.subjectKey]
      );
      if (open.rowCount !== null && open.rowCount > 0) {
        const id = open.rows[0].id as string;
        const same = await client.query(
          `UPDATE incidents
           SET last_seen_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND signal_token IS NOT DISTINCT FROM $2
           RETURNING *`,
          [id, candidate.signalToken]
        );
        if (same.rowCount !== null && same.rowCount > 0) {
          return { outcome: "touched", incident: same.rows[0] as Incident };
        }
        const bumped = await client.query(
          `UPDATE incidents
           SET signal_token = $2,
               source_timestamp = $3,
               occurrence_count = occurrence_count + 1,
               severity = $4,
               title = $5,
               detail = $6,
               error_code = $7,
               evidence = $8::jsonb,
               last_seen_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING *`,
          [
            id,
            candidate.signalToken,
            sourceTimestamp,
            candidate.severity,
            title,
            detail,
            errorCode,
            JSON.stringify(evidence),
          ]
        );
        if (bumped.rowCount !== null && bumped.rowCount > 0) {
          return { outcome: "updated", incident: bumped.rows[0] as Incident };
        }
        return { outcome: "skipped", reason: "incident vanished mid-update" };
      }

      const resolved = await client.query(
        `SELECT resolved_at, resolution, signal_token FROM incidents
         WHERE project_id = $1 AND subject_key = $2 AND status = 'resolved'
         ORDER BY resolved_at DESC NULLS LAST
         LIMIT 1
         FOR UPDATE`,
        [candidate.projectId, candidate.subjectKey]
      );
      if (resolved.rowCount !== null && resolved.rowCount > 0) {
        // Recurrence policy, explicitly tested:
        //   - The signal must be NEWER than the recorded resolution. Older
        //     evidence never reopens or overrides a recovery (safeguard 5).
        //   - An AUTO resolution means we verified the source recovered, so the
        //     same failure identity recurring is a genuine new episode.
        //   - A MANUAL resolution silences the current failure identity: it only
        //     reopens for a DIFFERENT signal identity (e.g. a new gateway
        //     request, a different error code). Resolved history is preserved
        //     either way — recurrence creates a new row (safeguard 4).
        const row = resolved.rows[0];
        const resolvedAt = toDate(row.resolved_at);
        const newerThanResolution =
          resolvedAt !== null &&
          sourceTimestamp.getTime() > resolvedAt.getTime();
        const identityChanged = row.signal_token !== candidate.signalToken;
        const allowedByAutoRecovery = row.resolution === "auto";
        if (!newerThanResolution) {
          return {
            outcome: "skipped",
            reason: "signal predates the recorded recovery",
          };
        }
        if (!allowedByAutoRecovery && !identityChanged) {
          return {
            outcome: "skipped",
            reason: "manually resolved signal identity is silenced",
          };
        }
      }

      const inserted = await client.query(
        `INSERT INTO incidents (
           project_id, kind, subject_key, status, severity, title, detail,
           error_code, evidence, signal_token, source_timestamp,
           occurrence_count, first_seen_at, last_seen_at
         ) VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8::jsonb, $9, $10, 1,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING *`,
        [
          candidate.projectId,
          candidate.kind,
          candidate.subjectKey,
          candidate.severity,
          title,
          detail,
          errorCode,
          JSON.stringify(evidence),
          candidate.signalToken,
          sourceTimestamp,
        ]
      );
      return {
        outcome: "created",
        incident: inserted.rows[0] as Incident,
      };
    });

  try {
    return await run();
  } catch (error) {
    // Unique-violation race: a concurrent sweep created the open incident for
    // this subject between our lock read and the insert. The partial unique
    // index guarantees at most one open row; retry once, which then finds it
    // and performs the idempotent touch/bump instead.
    if (
      error !== null &&
      typeof error === "object" &&
      (error as { code?: string }).code === "23505"
    ) {
      return await run();
    }
    throw error;
  }
}

/**
 * Guarded acknowledge: open -> acknowledged only. Re-acking, resolving an
 * already resolved incident, etc. throw IncidentStateError (409 upstream).
 */
export async function acknowledgeIncident(input: {
  projectId: string;
  incidentId: string;
  userId: string;
}): Promise<Incident> {
  return tx(async (client) => {
    const row = await client.query(
      `SELECT id, status FROM incidents
       WHERE id = $1 AND project_id = $2
       FOR UPDATE`,
      [input.incidentId, input.projectId]
    );
    if (row.rowCount === null || row.rowCount === 0) {
      throw new IncidentNotFoundError();
    }
    const status = row.rows[0].status as IncidentStatus;
    if (status === "acknowledged") {
      throw new IncidentStateError("Incident is already acknowledged");
    }
    if (status === "resolved") {
      throw new IncidentStateError("Incident is already resolved");
    }
    const updated = await client.query(
      `UPDATE incidents
       SET status = 'acknowledged',
           acknowledged_at = CURRENT_TIMESTAMP,
           acknowledged_by = $2
       WHERE id = $1 AND status = 'open'
       RETURNING *`,
      [input.incidentId, input.userId]
    );
    if (updated.rowCount === null || updated.rowCount === 0) {
      throw new IncidentStateError(
        "Incident is no longer open; refresh and retry"
      );
    }
    return updated.rows[0] as Incident;
  });
}

/**
 * Guarded resolve: open|acknowledged -> resolved (manual). Deployment
 * failures have no recovery predicate, so they resolve manually only.
 */
export async function resolveIncident(input: {
  projectId: string;
  incidentId: string;
}): Promise<Incident> {
  return tx(async (client) => {
    const row = await client.query(
      `SELECT id, status FROM incidents
       WHERE id = $1 AND project_id = $2
       FOR UPDATE`,
      [input.incidentId, input.projectId]
    );
    if (row.rowCount === null || row.rowCount === 0) {
      throw new IncidentNotFoundError();
    }
    const status = row.rows[0].status as IncidentStatus;
    if (status === "resolved") {
      throw new IncidentStateError("Incident is already resolved");
    }
    const updated = await client.query(
      `UPDATE incidents
       SET status = 'resolved',
           resolved_at = CURRENT_TIMESTAMP,
           resolution = 'manual'
       WHERE id = $1 AND status <> 'resolved'
       RETURNING *`,
      [input.incidentId]
    );
    if (updated.rowCount === null || updated.rowCount === 0) {
      throw new IncidentStateError(
        "Incident was already resolved; refresh and retry"
      );
    }
    return updated.rows[0] as Incident;
  });
}

export async function listIncidents(input: {
  projectId: string;
  status?: IncidentStatus | "active" | "all";
  kind?: IncidentKind;
  limit?: number;
}): Promise<Incident[]> {
  const limit = Number.isFinite(input.limit)
    ? Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100)
    : 50;
  const values: unknown[] = [input.projectId];
  let statusClause = "";
  const status = input.status ?? "active";
  if (status === "active") {
    statusClause = "AND status <> 'resolved'";
  } else if (status !== "all") {
    values.push(status);
    statusClause = `AND status = $${values.length}`;
  }
  let kindClause = "";
  if (input.kind) {
    if (!INCIDENT_KINDS.includes(input.kind)) {
      throw new Error("Invalid incident kind");
    }
    values.push(input.kind);
    kindClause = `AND kind = $${values.length}`;
  }
  values.push(limit);
  const result = await pool.query<Incident>(
    `SELECT * FROM incidents
     WHERE project_id = $1 ${statusClause} ${kindClause}
     ORDER BY last_seen_at DESC, id DESC
     LIMIT $${values.length}`,
    values
  );
  return result.rows;
}

export async function getIncident(input: {
  projectId: string;
  incidentId: string;
}): Promise<Incident> {
  const result = await pool.query<Incident>(
    `SELECT * FROM incidents WHERE id = $1 AND project_id = $2`,
    [input.incidentId, input.projectId]
  );
  if (result.rowCount === null || result.rowCount === 0) {
    throw new IncidentNotFoundError();
  }
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Detectors — each reads current source state and emits bounded candidates.
// ---------------------------------------------------------------------------

type Detector = () => Promise<IncidentCandidate[]>;

/** A failed deployment. Terminal by definition: manual resolve only. */
export const detectDeploymentFailures: Detector = async () => {
  const result = await pool.query(
    `SELECT d.id, d.project_id, d.branch, d.commit_sha, d.error_code,
            d.error_message, d.updated_at,
            (SELECT jsonb_agg(jsonb_build_object(
                'event_type', e.event_type, 'message', e.message,
                'at', e.created_at::text)
              ORDER BY e.created_at DESC, e.id DESC)
             FROM deployment_events e
             WHERE e.deployment_id = d.id
             LIMIT 5) AS recent_events
     FROM deployments d
     WHERE d.status = 'failed'
     ORDER BY d.updated_at DESC
     LIMIT ${DETECTOR_ROW_LIMIT}`
  );
  return result.rows.map((row: Record<string, unknown>) => {
    const deploymentId = String(row.id);
    const recentEvents = Array.isArray(row.recent_events)
      ? (row.recent_events as Record<string, unknown>[])
          .slice(0, 5)
          .map((e) => `${String(e.event_type)}: ${String(e.message ?? "")}`)
          .join(" | ")
      : null;
    return {
      projectId: String(row.project_id),
      kind: "deployment_failure" as const,
      subjectKey: `deployment:${deploymentId}`,
      severity: "warning" as const,
      title: `Deployment failed on ${String(row.branch)}`,
      detail:
        clipOrNull(row.error_message, MAX_DETAIL) ??
        "Deployment reached the failed state.",
      errorCode: clipOrNull(row.error_code, MAX_ERROR_CODE),
      evidence: sanitizeEvidence({
        deployment_id: deploymentId,
        branch: row.branch,
        commit_sha: row.commit_sha,
        failed_at: toDate(row.updated_at)?.toISOString() ?? null,
        recent_events: recentEvents,
      }),
      signalToken: `failed:${deploymentId}`,
      sourceTimestamp: toDate(row.updated_at) ?? new Date(),
    };
  });
};

/** Runtime instance unhealthy per its own recorded status. */
export const detectRuntimeUnhealthy: Detector = async () => {
  const result = await pool.query(
    `SELECT ri.id, ri.release_id, ri.status, ri.error_code, ri.error_message,
            ri.container_name, ri.container_port, ri.started_at,
            ri.last_health_check_at, r.project_id, r.deployment_id
     FROM runtime_instances ri
     JOIN releases r ON r.id = ri.release_id
     WHERE ri.status = 'unhealthy'
     ORDER BY ri.last_health_check_at DESC NULLS LAST
     LIMIT ${DETECTOR_ROW_LIMIT}`
  );
  return result.rows.map((row: Record<string, unknown>) => {
    const instanceId = String(row.id);
    return {
      projectId: String(row.project_id),
      kind: "runtime_unhealthy" as const,
      subjectKey: `runtime:${instanceId}`,
      severity: "critical" as const,
      title: `Runtime instance is ${String(row.status)}`,
      detail:
        clipOrNull(row.error_message, MAX_DETAIL) ??
        "Runtime instance reported an unhealthy status.",
      errorCode: clipOrNull(row.error_code, MAX_ERROR_CODE),
      evidence: sanitizeEvidence({
        runtime_instance_id: instanceId,
        release_id: row.release_id,
        deployment_id: row.deployment_id,
        container_name: row.container_name,
        container_port: row.container_port,
        instance_status: row.status,
        last_health_check_at: toDate(row.last_health_check_at)?.toISOString() ??
          null,
      }),
      signalToken: `unhealthy:${instanceId}:${String(row.error_code ?? row.status)}`,
      sourceTimestamp:
        toDate(row.last_health_check_at) ??
        toDate(row.started_at) ??
        new Date(),
    };
  });
};

/** Failed gateway sync requests (project-scoped, newest failure per project). */
export const detectGatewaySyncFailures: Detector = async () => {
  const result = await pool.query(
    `SELECT gs.id, gs.project_id, gs.reason, gs.status, gs.attempts,
            gs.max_attempts, gs.last_error, gs.updated_at
     FROM gateway_sync_requests gs
     WHERE gs.status = 'failed'
       AND gs.id = (
         SELECT g2.id FROM gateway_sync_requests g2
         WHERE g2.project_id = gs.project_id
         ORDER BY g2.updated_at DESC
         LIMIT 1
       )
     ORDER BY gs.updated_at DESC
     LIMIT ${DETECTOR_ROW_LIMIT}`
  );
  return result.rows.map((row: Record<string, unknown>) => {
    const projectId = String(row.project_id);
    return {
      projectId,
      kind: "gateway_sync_failed" as const,
      subjectKey: `gateway:${projectId}`,
      severity: "warning" as const,
      title: `Gateway sync failed (${String(row.reason)})`,
      detail:
        clipOrNull(row.last_error, MAX_DETAIL) ??
        "The gateway sync request failed.",
      errorCode: "GATEWAY_SYNC_FAILED",
      evidence: sanitizeEvidence({
        gateway_sync_request_id: row.id,
        reason: row.reason,
        request_status: row.status,
        attempts: row.attempts,
        max_attempts: row.max_attempts,
        last_error: row.last_error,
        failed_at: toDate(row.updated_at)?.toISOString() ?? null,
      }),
      signalToken: `gateway:${projectId}:${String(row.id)}`,
      sourceTimestamp: toDate(row.updated_at) ?? new Date(),
    };
  });
};

/** Custom domain TLS failures and expired certificates. */
export const detectTlsFailures: Detector = async () => {
  const result = await pool.query(
    `SELECT cd.id, cd.project_id, cd.domain, cd.status, cd.tls_status,
            cd.tls_last_error_code, cd.tls_last_error, cd.tls_last_attempt_at,
            cd.cert_expires_at, cd.updated_at
     FROM custom_domains cd
     WHERE cd.status = 'verified'
       AND (
         cd.tls_status = 'failed'
         OR cd.tls_status = 'expired'
         OR (
           cd.tls_status = 'issued'
           AND cd.cert_expires_at IS NOT NULL
           AND cd.cert_expires_at < CURRENT_TIMESTAMP
         )
       )
     ORDER BY cd.updated_at DESC
     LIMIT ${DETECTOR_ROW_LIMIT}`
  );
  return result.rows.map((row: Record<string, unknown>) => {
    const domainId = String(row.id);
    const domain = String(row.domain);
    const tlsStatus = String(row.tls_status);
    const expired =
      tlsStatus === "expired" ||
      (tlsStatus === "issued" &&
        toDate(row.cert_expires_at) !== null &&
        toDate(row.cert_expires_at)!.getTime() < Date.now());
    const detail = expired
      ? `Certificate for ${domain} has expired.`
      : clipOrNull(row.tls_last_error, MAX_DETAIL) ??
        "TLS certificate issuance failed.";
    return {
      projectId: String(row.project_id),
      kind: "tls_failure" as const,
      subjectKey: `tls:${domainId}`,
      severity: (expired ? "critical" : "warning") as IncidentSeverity,
      title: expired
        ? `TLS certificate expired for ${domain}`
        : `TLS certificate failed for ${domain}`,
      detail,
      errorCode: expired
        ? "TLS_CERT_EXPIRED"
        : clipOrNull(row.tls_last_error_code, MAX_ERROR_CODE),
      evidence: sanitizeEvidence({
        domain_id: domainId,
        domain,
        domain_status: row.status,
        tls_status: row.tls_status,
        cert_expires_at: toDate(row.cert_expires_at)?.toISOString() ?? null,
        tls_last_attempt_at:
          toDate(row.tls_last_attempt_at)?.toISOString() ?? null,
        tls_last_error: row.tls_last_error,
      }),
      signalToken: expired
        ? `expired:${domainId}`
        : `tls-failed:${domainId}:${String(row.tls_last_error_code ?? "unknown")}`,
      sourceTimestamp:
        toDate(row.tls_last_attempt_at) ??
        toDate(row.cert_expires_at) ??
        toDate(row.updated_at) ??
        new Date(),
    };
  });
};

/**
 * Failed GitHub webhook deliveries. Attribution rule: the delivery's own
 * deployment wins; otherwise the repository must be linked to exactly one
 * project. Deliveries that cannot be reliably attributed are skipped.
 */
export const detectWebhookFailures: Detector = async () => {
  const result = await pool.query(
    `SELECT d.delivery_id, d.event_type, d.repository_full_name, d.status,
            d.deployment_id, d.error, d.updated_at, d.attempts,
            dep.project_id AS deployment_project_id
     FROM github_webhook_deliveries d
     LEFT JOIN deployments dep ON dep.id = d.deployment_id
     WHERE d.status = 'failed'
       AND d.updated_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
     ORDER BY d.updated_at DESC
     LIMIT ${DETECTOR_ROW_LIMIT}`
  );

  const candidates: IncidentCandidate[] = [];
  for (const row of result.rows as Record<string, unknown>[]) {
    const deliveryId = String(row.delivery_id);
    let projectId =
      typeof row.deployment_project_id === "string"
        ? row.deployment_project_id
        : null;
    let attribution = "deployment";

    if (projectId === null && typeof row.repository_full_name === "string") {
      const linked = await pool.query(
        `SELECT p.id FROM github_repositories r
         JOIN projects p ON p.github_repository_id = r.id
         WHERE lower(r.full_name) = lower($1)`,
        [row.repository_full_name]
      );
      if (linked.rowCount === 1) {
        projectId = linked.rows[0].id as string;
        attribution = "repository";
      } else {
        // Ambiguous (0 or >1 projects): skip, never guess.
        continue;
      }
    }
    if (projectId === null) continue;

    candidates.push({
      projectId,
      kind: "webhook_failed",
      subjectKey: `webhook:${deliveryId}`,
      severity: "warning",
      title: `GitHub webhook delivery failed (${String(row.event_type)})`,
      detail:
        clipOrNull(row.error, MAX_DETAIL) ??
        "The webhook delivery reached the failed state.",
      errorCode: "WEBHOOK_DELIVERY_FAILED",
      evidence: sanitizeEvidence({
        delivery_id: deliveryId,
        event_type: row.event_type,
        repository_full_name: row.repository_full_name,
        deployment_id: row.deployment_id,
        delivery_status: row.status,
        attempts: row.attempts,
        error: row.error,
        failed_at: toDate(row.updated_at)?.toISOString() ?? null,
        attribution,
      }),
      signalToken: `webhook:${deliveryId}`,
      sourceTimestamp: toDate(row.updated_at) ?? new Date(),
    });
  }
  return candidates;
};

// ---------------------------------------------------------------------------
// Sweep orchestration — one detector failing never blocks the others.
// ---------------------------------------------------------------------------

export interface SweepSummary {
  created: number;
  updated: number;
  touched: number;
  skipped: number;
  resolved: number;
  errors: string[];
}

type RecoveryCheck = {
  kind: IncidentKind;
  /**
   * Returns incident ids of open/acknowledged incidents of this kind whose
   * source has verifiably recovered (fresh read, newer than the incident).
   */
  recoveredIds: (incident: Incident) => Promise<string | null>;
};

/**
 * Verified-recovery predicates. Each reads current source state; recovery is
 * only accepted when the source row proves health AND its timestamp is newer
 * than the incident's recorded signal (an old failure can never override a
 * newer recovery, and recovery itself is never fabricated).
 */
const RECOVERY_CHECKS: RecoveryCheck[] = [
  {
    kind: "runtime_unhealthy",
    recoveredIds: async (incident) => {
      const match = /^runtime:(.+)$/.exec(incident.subject_key);
      if (!match) return null;
      const result = await pool.query(
        `SELECT ri.status, ri.error_code, ri.last_health_check_at
         FROM runtime_instances ri WHERE ri.id = $1`,
        [match[1]]
      );
      if (result.rowCount === null || result.rowCount === 0) return null;
      const row = result.rows[0];
      if (String(row.status) !== "running" || row.error_code !== null) {
        return null;
      }
      const healthyAt = toDate(row.last_health_check_at);
      const incidentAt = toDate(incident.source_timestamp);
      if (healthyAt === null) return null;
      if (incidentAt !== null && healthyAt.getTime() <= incidentAt.getTime()) {
        return null;
      }
      return incident.id;
    },
  },
  {
    kind: "gateway_sync_failed",
    recoveredIds: async (incident) => {
      const result = await pool.query(
        `SELECT id, status, updated_at FROM gateway_sync_requests
         WHERE project_id = $1
         ORDER BY updated_at DESC
         LIMIT 1`,
        [incident.project_id]
      );
      if (result.rowCount === null || result.rowCount === 0) return null;
      const row = result.rows[0];
      if (String(row.status) !== "done") return null;
      const doneAt = toDate(row.updated_at);
      const incidentAt = toDate(incident.source_timestamp);
      if (doneAt === null) return null;
      if (incidentAt !== null && doneAt.getTime() <= incidentAt.getTime()) {
        return null;
      }
      return incident.id;
    },
  },
  {
    kind: "tls_failure",
    recoveredIds: async (incident) => {
      const match = /^tls:(.+)$/.exec(incident.subject_key);
      if (!match) return null;
      const result = await pool.query(
        `SELECT tls_status, cert_expires_at, updated_at
         FROM custom_domains WHERE id = $1`,
        [match[1]]
      );
      if (result.rowCount === null || result.rowCount === 0) return null;
      const row = result.rows[0];
      if (String(row.tls_status) !== "issued") return null;
      const expiresAt = toDate(row.cert_expires_at);
      if (expiresAt !== null && expiresAt.getTime() <= Date.now()) return null;
      const issuedAt = toDate(row.updated_at);
      const incidentAt = toDate(incident.source_timestamp);
      if (issuedAt === null) return null;
      if (incidentAt !== null && issuedAt.getTime() <= incidentAt.getTime()) {
        return null;
      }
      return incident.id;
    },
  },
  {
    kind: "webhook_failed",
    recoveredIds: async (incident) => {
      const match = /^webhook:(.+)$/.exec(incident.subject_key);
      if (!match) return null;
      const result = await pool.query(
        `SELECT status, updated_at FROM github_webhook_deliveries
         WHERE delivery_id = $1`,
        [match[1]]
      );
      if (result.rowCount === null || result.rowCount === 0) return null;
      const row = result.rows[0];
      if (String(row.status) !== "processed") return null;
      const processedAt = toDate(row.updated_at);
      const incidentAt = toDate(incident.source_timestamp);
      if (processedAt === null) return null;
      if (incidentAt !== null && processedAt.getTime() <= incidentAt.getTime()) {
        return null;
      }
      return incident.id;
    },
  },
  // deployment_failure intentionally absent: manual resolve only.
];

async function resolveRecoveredIncidents(summary: SweepSummary): Promise<void> {
  const open = await pool.query<Incident>(
    `SELECT * FROM incidents
     WHERE status <> 'resolved'
     ORDER BY last_seen_at DESC
     LIMIT ${RECOVERY_ROW_LIMIT}`
  );
  for (const incident of open.rows) {
    const check = RECOVERY_CHECKS.find((c) => c.kind === incident.kind);
    if (!check) continue;
    let recoveredId: string | null = null;
    try {
      recoveredId = await check.recoveredIds(incident);
    } catch (error) {
      summary.errors.push(
        `recovery:${incident.kind}: ${
          error instanceof Error ? error.message.slice(0, 200) : "unknown"
        }`
      );
      continue;
    }
    if (recoveredId === null) continue;
    const resolved = await pool.query(
      `UPDATE incidents
       SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP,
           resolution = 'auto'
       WHERE id = $1 AND status <> 'resolved'`,
      [recoveredId]
    );
    if (resolved.rowCount !== null && resolved.rowCount > 0) {
      summary.resolved += 1;
    }
  }
}

const DETECTORS: { name: string; run: Detector }[] = [
  { name: "deployment_failure", run: detectDeploymentFailures },
  { name: "runtime_unhealthy", run: detectRuntimeUnhealthy },
  { name: "gateway_sync_failed", run: detectGatewaySyncFailures },
  { name: "tls_failure", run: detectTlsFailures },
  { name: "webhook_failed", run: detectWebhookFailures },
];

/**
 * One sweep: recover first (so a signal from this sweep cannot race the
 * recovery it caused), then each detector independently. A detector or
 * persistence failure is recorded and never stops the remaining work.
 */
export async function runIncidentSweep(
  detectors: { name: string; run: Detector }[] = DETECTORS
): Promise<SweepSummary> {
  const summary: SweepSummary = {
    created: 0,
    updated: 0,
    touched: 0,
    skipped: 0,
    resolved: 0,
    errors: [],
  };

  try {
    await resolveRecoveredIncidents(summary);
  } catch (error) {
    summary.errors.push(
      `recovery: ${
        error instanceof Error ? error.message.slice(0, 200) : "unknown"
      }`
    );
  }

  for (const detector of detectors) {
    let candidates: IncidentCandidate[];
    try {
      candidates = await detector.run();
    } catch (error) {
      summary.errors.push(
        `${detector.name}: ${
          error instanceof Error ? error.message.slice(0, 200) : "unknown"
        }`
      );
      continue;
    }
    for (const candidate of candidates) {
      try {
        const result = await persistCandidate(candidate);
        if (result.outcome === "created") summary.created += 1;
        else if (result.outcome === "updated") summary.updated += 1;
        else if (result.outcome === "touched") summary.touched += 1;
        else summary.skipped += 1;
      } catch (error) {
        summary.errors.push(
          `${detector.name}:persist: ${
            error instanceof Error ? error.message.slice(0, 200) : "unknown"
          }`
        );
      }
    }
  }

  return summary;
}
