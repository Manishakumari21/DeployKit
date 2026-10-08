import crypto from "node:crypto";
import pool from "../db/database.js";
import { withTransaction } from "../db/transaction.js";

export const AGENT_TOKEN_BYTES = 32;
export const MAX_AGENT_NAME_LENGTH = 100;
export const MAX_AGENT_VERSION_LENGTH = 100;

export type AgentStatus = "pending" | "online" | "offline" | "revoked";

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  status: AgentStatus;
  lastHeartbeatAt: string | null;
  version: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCredential {
  id: string;
  agentId: string;
  revokedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedAgentCredential extends AgentCredential {
  token: string;
}

export interface ResolvedAgentCredential {
  credentialId: string;
  agentId: string;
  projectId: string;
}

export interface EnrollmentOptions {
  expiresAt?: Date | string | null;
}

export class AgentError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.status = status;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_STATUSES: readonly string[] = [
  "pending",
  "online",
  "offline",
  "revoked",
];

export function hashAgentToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function isDbCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

function validateId(id: unknown, code: string): string {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw new AgentError(code, "Invalid id");
  }
  return id;
}

function validateAgentName(name: unknown): string {
  if (typeof name !== "string") {
    throw new AgentError("INVALID_NAME", "Invalid agent name");
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_AGENT_NAME_LENGTH) {
    throw new AgentError("INVALID_NAME", "Invalid agent name");
  }
  return trimmed;
}

function validateVersion(version: unknown): string | null {
  if (version === undefined || version === null) return null;
  if (
    typeof version !== "string" ||
    version.length < 1 ||
    version.length > MAX_AGENT_VERSION_LENGTH
  ) {
    throw new AgentError("INVALID_VERSION", "Invalid agent version");
  }
  return version;
}

function validateExpiry(expiresAt: Date | string | null | undefined): string | null {
  if (expiresAt === undefined || expiresAt === null) return null;
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new AgentError("INVALID_EXPIRY", "Invalid credential expiry");
  }
  return date.toISOString();
}

interface AgentRow {
  id: string;
  project_id: string;
  name: string;
  status: AgentStatus;
  last_heartbeat_at: string | null;
  version: string | null;
  created_at: string;
  updated_at: string;
}

function toAgent(row: AgentRow): Agent {
  if (!AGENT_STATUSES.includes(row.status)) {
    throw new AgentError("AGENT_CORRUPT", "Unknown agent status", 500);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    status: row.status,
    lastHeartbeatAt: row.last_heartbeat_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface CredentialRow {
  id: string;
  agent_id: string;
  revoked_at: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

function toCredential(
  row: CredentialRow,
  token: string | null
): AgentCredential | CreatedAgentCredential {
  const base = {
    id: row.id,
    agentId: row.agent_id,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
  return token === null ? base : { ...base, token };
}

interface QueryExecutor {
  query(
    queryText: string,
    values?: unknown[]
  ): Promise<{ rows: CredentialRow[] }>;
}

export async function createAgent(
  projectId: string,
  name: string
): Promise<Agent> {
  const validProject = validateId(projectId, "INVALID_PROJECT");
  const validName = validateAgentName(name);
  try {
    const result = await pool.query(
      `
      INSERT INTO agents (project_id, name, status)
      VALUES ($1, $2, 'pending')
      RETURNING id, project_id, name, status,
        last_heartbeat_at, version, created_at, updated_at
      `,
      [validProject, validName]
    );
    return toAgent(result.rows[0] as AgentRow);
  } catch (error) {
    if (isDbCode(error, "23505")) {
      throw new AgentError(
        "AGENT_NAME_TAKEN",
        "Agent name already exists in this project",
        409
      );
    }
    if (isDbCode(error, "23503")) {
      throw new AgentError("PROJECT_NOT_FOUND", "Project not found", 404);
    }
    throw error;
  }
}

export async function getAgentById(agentId: string): Promise<Agent | null> {
  if (typeof agentId !== "string" || !UUID_PATTERN.test(agentId)) return null;
  const result = await pool.query(
    `
    SELECT id, project_id, name, status,
      last_heartbeat_at, version, created_at, updated_at
    FROM agents
    WHERE id = $1
    LIMIT 1
    `,
    [agentId]
  );
  const row = result.rows[0] as AgentRow | undefined;
  return row === undefined ? null : toAgent(row);
}

export async function listProjectAgents(projectId: string): Promise<Agent[]> {
  if (typeof projectId !== "string" || !UUID_PATTERN.test(projectId)) return [];
  const result = await pool.query(
    `
    SELECT id, project_id, name, status,
      last_heartbeat_at, version, created_at, updated_at
    FROM agents
    WHERE project_id = $1
    ORDER BY created_at ASC
    `,
    [projectId]
  );
  return (result.rows as AgentRow[]).map(toAgent);
}

export async function updateAgentHeartbeat(
  agentId: string,
  version?: string
): Promise<Agent> {
  const validId = validateId(agentId, "INVALID_AGENT");
  const validVersion = validateVersion(version);
  const result = await pool.query(
    `
    UPDATE agents
    SET last_heartbeat_at = NOW(),
        version = COALESCE($2, version)
    WHERE id = $1 AND status != 'revoked'
    RETURNING id, project_id, name, status,
      last_heartbeat_at, version, created_at, updated_at
    `,
    [validId, validVersion]
  );
  const row = result.rows[0] as AgentRow | undefined;
  if (row !== undefined) return toAgent(row);
  const existing = await getAgentById(validId);
  if (existing !== null) {
    throw new AgentError("AGENT_REVOKED", "Agent is revoked", 403);
  }
  throw new AgentError("AGENT_NOT_FOUND", "Agent not found", 404);
}

export async function revokeAgent(agentId: string): Promise<boolean> {
  const validId = validateId(agentId, "INVALID_AGENT");
  const result = await pool.query(
    `
    UPDATE agents
    SET status = 'revoked'
    WHERE id = $1 AND status != 'revoked'
    `,
    [validId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function insertCredentialRow(
  db: QueryExecutor,
  agentId: string,
  expiresAt: string | null
): Promise<CredentialRow> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = crypto.randomBytes(AGENT_TOKEN_BYTES).toString("hex");
    try {
      const result = await db.query(
        `
        INSERT INTO agent_credentials (agent_id, token_hash, expires_at)
        VALUES ($1, $2, $3)
        RETURNING id, agent_id, revoked_at, expires_at,
          last_used_at, created_at
        `,
        [agentId, hashAgentToken(token), expiresAt]
      );
      const row = result.rows[0] as CredentialRow;
      return { ...row, token } as CredentialRow & { token: string };
    } catch (error) {
      if (!isDbCode(error, "23505") || attempt === 2) throw error;
    }
  }
  throw new AgentError("CREDENTIAL_FAILED", "Could not issue credential", 500);
}

async function requireLiveAgent(agentId: string): Promise<void> {
  const result = await pool.query(
    `SELECT status FROM agents WHERE id = $1`,
    [agentId]
  );
  const row = result.rows[0] as { status: string } | undefined;
  if (row === undefined) {
    throw new AgentError("AGENT_NOT_FOUND", "Agent not found", 404);
  }
  if (row.status === "revoked") {
    throw new AgentError("AGENT_REVOKED", "Agent is revoked", 403);
  }
}

export async function createEnrollmentCredential(
  agentId: string,
  options?: EnrollmentOptions
): Promise<CreatedAgentCredential> {
  const validId = validateId(agentId, "INVALID_AGENT");
  const expiresAt = validateExpiry(options?.expiresAt ?? null);
  await requireLiveAgent(validId);
  try {
    const row = await insertCredentialRow(pool, validId, expiresAt);
    const token = (row as CredentialRow & { token: string }).token;
    return toCredential(row, token) as CreatedAgentCredential;
  } catch (error) {
    if (isDbCode(error, "23503")) {
      throw new AgentError("AGENT_NOT_FOUND", "Agent not found", 404);
    }
    throw error;
  }
}

export async function resolveCredential(
  token: unknown
): Promise<ResolvedAgentCredential | null> {
  if (typeof token !== "string" || token.length === 0) return null;
  const result = await pool.query(
    `
    SELECT c.id AS credential_id, c.agent_id, a.project_id
    FROM agent_credentials c
    JOIN agents a ON a.id = c.agent_id
    WHERE c.token_hash = $1
      AND c.revoked_at IS NULL
      AND (c.expires_at IS NULL OR c.expires_at > NOW())
      AND a.status != 'revoked'
    LIMIT 1
    `,
    [hashAgentToken(token)]
  );
  const row = result.rows[0] as
    | { credential_id: string; agent_id: string; project_id: string }
    | undefined;
  if (row === undefined) return null;
  await pool.query(
    `UPDATE agent_credentials SET last_used_at = NOW() WHERE id = $1`,
    [row.credential_id]
  );
  return {
    credentialId: row.credential_id,
    agentId: row.agent_id,
    projectId: row.project_id,
  };
}

export async function revokeCredential(credentialId: string): Promise<boolean> {
  if (typeof credentialId !== "string" || !UUID_PATTERN.test(credentialId)) {
    return false;
  }
  const result = await pool.query(
    `
    UPDATE agent_credentials
    SET revoked_at = NOW()
    WHERE id = $1 AND revoked_at IS NULL
    `,
    [credentialId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function rotateCredential(
  agentId: string,
  options?: EnrollmentOptions
): Promise<CreatedAgentCredential> {
  const validId = validateId(agentId, "INVALID_AGENT");
  const expiresAt = validateExpiry(options?.expiresAt ?? null);
  return withTransaction(async (client) => {
    const agent = (
      await client.query(`SELECT status FROM agents WHERE id = $1`, [validId])
    ).rows[0] as { status: string } | undefined;
    if (agent === undefined) {
      throw new AgentError("AGENT_NOT_FOUND", "Agent not found", 404);
    }
    if (agent.status === "revoked") {
      throw new AgentError("AGENT_REVOKED", "Agent is revoked", 403);
    }
    await client.query(
      `
      UPDATE agent_credentials
      SET revoked_at = NOW()
      WHERE agent_id = $1 AND revoked_at IS NULL
      `,
      [validId]
    );
    const row = await insertCredentialRow(client, validId, expiresAt);
    const token = (row as CredentialRow & { token: string }).token;
    return toCredential(row, token) as CreatedAgentCredential;
  });
}
