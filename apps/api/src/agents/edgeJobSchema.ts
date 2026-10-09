// Phase 12.4: strict runtime validation for edge-agent job payloads.
//
// The agent communicates only through the control-plane API and must never
// trust agent-supplied identifiers, image references, or deployment states.
// Everything in this module validates untrusted input (HTTP bodies, operator
// config) before the executor acts on it.
//
// Source-of-truth shapes (verified against the implementation, not guessed):
//   apps/api/src/agents/agentJobService.ts  -> ClaimedAgentJob
//   apps/api/src/controllers/agentController.ts -> { job } envelope,
//      complete/failure body bounds (errorCode <= 100, errorMessage <= 4000)
//   apps/api/src/services/releaseService.ts -> DIGEST_PATTERN
//   apps/api/src/services/deploymentService.ts -> COMMIT_SHA_PATTERN
//
// NOTE: digest/commit patterns are mirrored here instead of imported because
// the defining modules pull in the PostgreSQL pool, which the edge agent
// must never touch. Semantics are identical; sources are cited above.

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors DIGEST_PATTERN in services/releaseService.ts.
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;

// Mirrors COMMIT_SHA_PATTERN in services/deploymentService.ts.
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

// Mirrors failBodySchema/completeBodySchema bounds in agentController.ts.
export const MAX_ERROR_CODE_LENGTH = 100;
export const MAX_ERROR_MESSAGE_LENGTH = 4000;

export const MAX_BRANCH_LENGTH = 255;
export const MAX_ATTEMPTS = 1000;

export class EdgeJobSchemaError extends Error {
  readonly code = "EDGE_JOB_SCHEMA";
  constructor(message: string) {
    super(message);
    this.name = "EdgeJobSchemaError";
  }
}

// Exact runtime shape of ClaimedAgentJob from agentJobService.ts. No image,
// registry, environment, port, health-check, or release fields exist on the
// wire today; this interface must track the server type, not extend it with
// guessed fields.
// Exact runtime shape of ClaimedAgentJob from agentJobService.ts. The image
// block is the minimal server-to-agent contract (AgentJobImage): present
// only when the control plane resolved a trusted digest-pinned reference
// from release/deployment records. Absent or null means no trustworthy
// image exists and the executor must fail closed.
export interface ClaimedEdgeJobImage {
  repository: string;
  digest: string;
  releaseId: string | null;
}

export interface ClaimedEdgeJob {
  id: string;
  deploymentId: string;
  projectId: string;
  agentId: string;
  attempts: number;
  maxAttempts: number;
  leaseExpiresAt: string | null;
  branch: string;
  commitSha: string | null;
  image: ClaimedEdgeJobImage | null;
}

// Subset of AgentJobState from agentJobService.ts used for lease
// reconciliation (heartbeat endpoint response).
export interface EdgeJobHeartbeatState {
  job: {
    id: string;
    deploymentId: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    leaseExpiresAt: string | null;
  };
  deployment: {
    id: string;
    status: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new EdgeJobSchemaError(`Invalid ${field}: expected UUID`);
  }
  return value;
}

function parseCount(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_ATTEMPTS
  ) {
    throw new EdgeJobSchemaError(`Invalid ${field}: expected 0..${MAX_ATTEMPTS}`);
  }
  return value;
}

function parseLease(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new EdgeJobSchemaError(`Invalid ${field}: expected ISO timestamp or null`);
  }
  return value;
}

function parseBranch(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_BRANCH_LENGTH ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f\s'"`$\\]/.test(value)
  ) {
    throw new EdgeJobSchemaError("Invalid branch: unexpected characters or length");
  }
  return value;
}

function parseCommitSha(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw new EdgeJobSchemaError("Invalid commitSha: expected 40-char hex SHA or null");
  }
  return value.toLowerCase();
}

function parseJobImage(value: unknown): ClaimedEdgeJobImage | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new EdgeJobSchemaError("Invalid image: expected object or null");
  }
  // Joint validation through the digest-pinned parser: only an immutable
  // repository@sha256:<64 hex> reference survives. Mutable tags, malformed
  // digests, and non-registry repositories fail closed here even if the
  // server ever sent them.
  if (typeof value.repository !== "string" || typeof value.digest !== "string") {
    throw new EdgeJobSchemaError("Invalid image: repository and digest must be strings");
  }
  const parsed = parseImageReference(`${value.repository}@${value.digest}`);
  const releaseId = value.releaseId;
  if (releaseId !== null && releaseId !== undefined) {
    if (typeof releaseId !== "string" || !UUID_PATTERN.test(releaseId)) {
      throw new EdgeJobSchemaError("Invalid image: releaseId must be a UUID or null");
    }
    return { repository: parsed.repository, digest: parsed.digest, releaseId };
  }
  return { repository: parsed.repository, digest: parsed.digest, releaseId: null };
}

function parseJobRecord(record: Record<string, unknown>): ClaimedEdgeJob {
  const attempts = parseCount(record.attempts, "attempts");
  const maxAttempts = parseCount(record.maxAttempts, "maxAttempts");
  if (maxAttempts < 1) {
    throw new EdgeJobSchemaError("Invalid maxAttempts: expected >= 1");
  }
  return {
    id: parseUuid(record.id, "job id"),
    deploymentId: parseUuid(record.deploymentId, "deployment id"),
    projectId: parseUuid(record.projectId, "project id"),
    agentId: parseUuid(record.agentId, "agent id"),
    attempts,
    maxAttempts,
    leaseExpiresAt: parseLease(record.leaseExpiresAt, "leaseExpiresAt"),
    branch: parseBranch(record.branch),
    commitSha: parseCommitSha(record.commitSha),
    image: parseJobImage(record.image),
  };
}

// Strictly parses the POST /api/agent/jobs/claim response body
// ({ job: ClaimedAgentJob | null }). Returns null when no work is available.
// Throws EdgeJobSchemaError on any shape deviation. Unknown extra fields are
// ignored (forward compatibility); missing or mistyped required fields fail.
export function parseClaimedJobResponse(body: unknown): ClaimedEdgeJob | null {
  if (!isRecord(body) || !("job" in body)) {
    throw new EdgeJobSchemaError("Invalid claim response: missing job envelope");
  }
  const { job } = body;
  if (job === null) return null;
  if (!isRecord(job)) {
    throw new EdgeJobSchemaError("Invalid claim response: job must be an object or null");
  }
  return parseJobRecord(job);
}

function parseHeartbeatJob(record: unknown): EdgeJobHeartbeatState["job"] {
  if (!isRecord(record)) {
    throw new EdgeJobSchemaError("Invalid heartbeat state: job must be an object");
  }
  return {
    id: parseUuid(record.id, "job id"),
    deploymentId: parseUuid(record.deploymentId, "deployment id"),
    status: typeof record.status === "string" && record.status.length <= 64
      ? record.status
      : (() => { throw new EdgeJobSchemaError("Invalid heartbeat state: bad job status"); })(),
    attempts: parseCount(record.attempts, "attempts"),
    maxAttempts: parseCount(record.maxAttempts, "maxAttempts"),
    leaseExpiresAt: parseLease(record.leaseExpiresAt, "leaseExpiresAt"),
  };
}

// Strictly parses the POST /api/agent/jobs/:jobId/heartbeat response body.
export function parseHeartbeatState(body: unknown): EdgeJobHeartbeatState {
  if (!isRecord(body)) {
    throw new EdgeJobSchemaError("Invalid heartbeat state: expected object");
  }
  if (!isRecord(body.job) || !isRecord(body.deployment)) {
    throw new EdgeJobSchemaError("Invalid heartbeat state: missing job/deployment");
  }
  const deploymentId = parseUuid(body.deployment.id, "deployment id");
  const deploymentStatus =
    typeof body.deployment.status === "string" && body.deployment.status.length <= 64
      ? body.deployment.status
      : (() => { throw new EdgeJobSchemaError("Invalid heartbeat state: bad deployment status"); })();
  const job = parseHeartbeatJob(body.job);
  if (job.deploymentId !== deploymentId) {
    throw new EdgeJobSchemaError("Invalid heartbeat state: deployment id mismatch");
  }
  return { job, deployment: { id: deploymentId, status: deploymentStatus } };
}

export interface ParsedImageReference {
  repository: string;
  digest: string;
}

// Accepts ONLY immutable digest-pinned references
// (repository@sha256:<64 hex>). Rejects mutable tags (":latest", ":v1",
// ":<sha>"), missing digests, malformed digests, whitespace, shell
// metacharacters, URL schemes, and overlong input. Mirrors the digest half
// of validateImageReference in dockerRuntimeManager.ts plus the repository
// rules of registryConfig.ts (lowercase, host-prefixed, no credentials).
export function parseImageReference(ref: unknown): ParsedImageReference {
  if (typeof ref !== "string") {
    throw new EdgeJobSchemaError("Invalid image reference: expected string");
  }
  const value = ref.trim();
  if (value.length === 0 || value.length > 1024) {
    throw new EdgeJobSchemaError("Invalid image reference: bad length");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s'"`$\\{}\u0000-\u001f\u007f]/.test(value)) {
    throw new EdgeJobSchemaError("Invalid image reference: illegal characters");
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    throw new EdgeJobSchemaError("Invalid image reference: URL scheme not allowed");
  }
  // Any tag separator that is not part of a digest reference means a mutable
  // tag (or garbage). Digest references use "@sha256:...", where the only
  // permitted ":" after the "@" is the digest algorithm separator.
  const atIndex = value.lastIndexOf("@");
  if (atIndex < 0) {
    throw new EdgeJobSchemaError(
      "Invalid image reference: mutable tags are forbidden, use repository@sha256:<digest>"
    );
  }
  const repository = value.slice(0, atIndex);
  const digest = value.slice(atIndex + 1);
  if (!DIGEST_PATTERN.test(digest)) {
    throw new EdgeJobSchemaError("Invalid image reference: malformed sha256 digest");
  }
  if (repository !== repository.toLowerCase()) {
    throw new EdgeJobSchemaError("Invalid image reference: repository must be lowercase");
  }
  if (repository.includes("@")) {
    throw new EdgeJobSchemaError("Invalid image reference: unexpected separator");
  }
  const repoParts = repository.split("/").filter(Boolean);
  if (repoParts.length < 2 || repository.endsWith("/") || repository.includes("//")) {
    throw new EdgeJobSchemaError("Invalid image reference: repository must include a registry host prefix");
  }
  // Docker's registry-host rule (mirrors the server claim contract): the
  // first component must contain a `.` or `:` or be `localhost`, otherwise
  // the name is local-only and would resolve against the default public
  // registry. Such references fail closed here.
  const hostPart = repoParts[0].toLowerCase();
  if (hostPart !== "localhost" && !hostPart.includes(".") && !hostPart.includes(":")) {
    throw new EdgeJobSchemaError("Invalid image reference: repository must name a registry host");
  }
  if (repository.includes(":") && !/:[0-9]{1,5}$/.test(repoParts[0])) {
    // A ":" in the repository is only legal as host:port on the first part.
    throw new EdgeJobSchemaError("Invalid image reference: tags are forbidden, use repository@sha256:<digest>");
  }
  if (repoParts.slice(repository.includes(":") ? 1 : 0).some((p) => p.includes(":"))) {
    throw new EdgeJobSchemaError("Invalid image reference: tags are forbidden, use repository@sha256:<digest>");
  }
  return { repository, digest: digest.toLowerCase() };
}

export function toImageReference(parsed: ParsedImageReference): string {
  return `${parsed.repository}@${parsed.digest}`;
}

// Bounds an error code to the failure-endpoint contract (1..100 chars).
export function boundErrorCode(code: unknown, fallback: string): string {
  const raw = typeof code === "string" && code.trim().length > 0 ? code.trim() : fallback;
  const sanitized = raw.replace(/[\r\n\0]/g, " ").replace(/\s+/g, " ").trim();
  const bounded = sanitized.slice(0, MAX_ERROR_CODE_LENGTH);
  return bounded.length > 0 ? bounded : fallback;
}

// Bounds an error message to the failure-endpoint contract (1..4000 chars)
// and redacts secret-bearing patterns (mirrors redactSecrets in
// services/deploymentLogService.ts without importing the DB-backed module).
export function boundErrorMessage(message: unknown, fallback: string): string {
  const raw =
    typeof message === "string" && message.trim().length > 0 ? message : fallback;
  return redactForLog(raw).slice(0, MAX_ERROR_MESSAGE_LENGTH) || fallback;
}

// Secret redaction for anything the agent logs or sends in bounded payloads.
// Same pattern semantics as redactSecrets in deploymentLogService.ts.
export function redactForLog(text: string): string {
  let out = text;
  out = out.replace(/bearer\s+[A-Za-z0-9\-._~+/=]+/gi, "bearer [redacted]");
  out = out.replace(/gh[pousr]_[A-Za-z0-9]+/g, "[redacted]");
  out = out.replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]");
  out = out.replace(/x-access-token:[^@\s]+/gi, "x-access-token:[redacted]");
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted-private-key]"
  );
  out = out.replace(/password\s*[:=]\s*\S+/gi, "password: [redacted]");
  return out;
}
