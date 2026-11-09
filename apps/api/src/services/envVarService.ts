import pool from "../db/database.js";
import { encryptSecret, decryptSecret } from "../security/encryption.js";

export class EnvVarError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "EnvVarError";
    this.code = code;
    this.status = status;
  }
}

export const MASKED_SECRET_VALUE = "••••••••";

const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "PORT",
  "DEPLOYKIT_DEPLOYMENT_ID",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProjectEnvVar {
  id: string;
  project_id: string;
  key: string;
  value: string;
  is_secret: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateEnvVarInput {
  key: string;
  value: string;
  isSecret?: boolean;
}

export interface UpdateEnvVarInput {
  key?: string;
  value?: string;
  isSecret?: boolean;
}

function validateKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new EnvVarError("INVALID_KEY", "Environment variable key must not be empty");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new EnvVarError(
      "INVALID_KEY",
      "Environment variable key must start with a letter or underscore and contain only alphanumeric characters and underscores"
    );
  }
  if (trimmed.length > 128) {
    throw new EnvVarError("INVALID_KEY", "Environment variable key must not exceed 128 characters");
  }
  if (RESERVED_KEYS.has(trimmed.toUpperCase())) {
    throw new EnvVarError("RESERVED_KEY", `Environment variable key '${trimmed}' is reserved by DeployKit`);
  }
  return trimmed;
}

function validateValue(value: string): string {
  if (typeof value !== "string") {
    throw new EnvVarError("INVALID_VALUE", "Environment variable value must be a string");
  }
  if (value.length > 32768) {
    throw new EnvVarError("INVALID_VALUE", "Environment variable value exceeds maximum length of 32,768 characters");
  }
  if (value.includes("\0")) {
    throw new EnvVarError("INVALID_VALUE", "Environment variable value must not contain null bytes");
  }
  return value;
}

function validateId(id: string, label = "id"): string {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw new EnvVarError("INVALID_ID", `Invalid ${label}`);
  }
  return id;
}

export async function getProjectEnvVars(projectId: string): Promise<ProjectEnvVar[]> {
  validateId(projectId, "project id");
  const result = await pool.query(
    `
    SELECT id, project_id, key, value_encrypted, is_secret, created_at, updated_at
    FROM project_env_vars
    WHERE project_id = $1
    ORDER BY key ASC
    `,
    [projectId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    project_id: row.project_id,
    key: row.key,
    value: row.is_secret ? MASKED_SECRET_VALUE : decryptSecret(row.value_encrypted),
    is_secret: row.is_secret,
    created_at: row.created_at.toISOString ? row.created_at.toISOString() : String(row.created_at),
    updated_at: row.updated_at.toISOString ? row.updated_at.toISOString() : String(row.updated_at),
  }));
}

export async function getProjectRuntimeEnv(projectId: string): Promise<Record<string, string>> {
  validateId(projectId, "project id");
  const result = await pool.query(
    `
    SELECT key, value_encrypted
    FROM project_env_vars
    WHERE project_id = $1
    ORDER BY key ASC
    `,
    [projectId]
  );

  const env: Record<string, string> = {};
  for (const row of result.rows) {
    try {
      env[row.key] = decryptSecret(row.value_encrypted);
    } catch {
      throw new EnvVarError(
        "ENV_DECRYPTION_FAILED",
        `Failed to decrypt environment variable '${row.key}'`,
        500
      );
    }
  }
  return env;
}

export async function createProjectEnvVar(
  projectId: string,
  input: CreateEnvVarInput
): Promise<ProjectEnvVar> {
  validateId(projectId, "project id");
  const key = validateKey(input.key);
  const value = validateValue(input.value);
  if (value === MASKED_SECRET_VALUE) {
    throw new EnvVarError("INVALID_VALUE", "Environment variable value cannot be the masked placeholder");
  }
  const isSecret = Boolean(input.isSecret);

  const valueEncrypted = encryptSecret(value);

  try {
    const result = await pool.query(
      `
      INSERT INTO project_env_vars (project_id, key, value_encrypted, is_secret)
      VALUES ($1, $2, $3, $4)
      RETURNING id, project_id, key, is_secret, created_at, updated_at
      `,
      [projectId, key, valueEncrypted, isSecret]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      project_id: row.project_id,
      key: row.key,
      value: isSecret ? MASKED_SECRET_VALUE : value,
      is_secret: row.is_secret,
      created_at: row.created_at.toISOString ? row.created_at.toISOString() : String(row.created_at),
      updated_at: row.updated_at.toISOString ? row.updated_at.toISOString() : String(row.updated_at),
    };
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      throw new EnvVarError("DUPLICATE_KEY", `Environment variable '${key}' already exists for this project`, 409);
    }
    throw error;
  }
}

export async function updateProjectEnvVar(
  projectId: string,
  varId: string,
  input: UpdateEnvVarInput
): Promise<ProjectEnvVar> {
  validateId(projectId, "project id");
  validateId(varId, "environment variable id");

  const existingRes = await pool.query(
    `
    SELECT id, project_id, key, value_encrypted, is_secret, created_at, updated_at
    FROM project_env_vars
    WHERE id = $1 AND project_id = $2
    `,
    [varId, projectId]
  );

  if (existingRes.rowCount === 0) {
    throw new EnvVarError("NOT_FOUND", "Environment variable not found", 404);
  }

  const existing = existingRes.rows[0];
  const newKey = input.key !== undefined ? validateKey(input.key) : existing.key;
  const newIsSecret = input.isSecret !== undefined ? Boolean(input.isSecret) : existing.is_secret;

  let newValueEncrypted = existing.value_encrypted;
  let returnedValue: string;

  if (input.value !== undefined && input.value !== MASKED_SECRET_VALUE) {
    const val = validateValue(input.value);
    newValueEncrypted = encryptSecret(val);
    returnedValue = newIsSecret ? MASKED_SECRET_VALUE : val;
  } else {
    // Value was omitted or left as mask
    if (existing.is_secret && !newIsSecret) {
      throw new EnvVarError(
        "INVALID_VALUE",
        "A replacement value is required when converting a secret to plaintext"
      );
    }
    if (!existing.is_secret && input.value === MASKED_SECRET_VALUE) {
      throw new EnvVarError(
        "INVALID_VALUE",
        "Environment variable value cannot be the masked placeholder"
      );
    }
    returnedValue = newIsSecret ? MASKED_SECRET_VALUE : decryptSecret(existing.value_encrypted);
  }

  try {
    const updateRes = await pool.query(
      `
      UPDATE project_env_vars
      SET key = $3, value_encrypted = $4, is_secret = $5, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND project_id = $2
      RETURNING id, project_id, key, is_secret, created_at, updated_at
      `,
      [varId, projectId, newKey, newValueEncrypted, newIsSecret]
    );

    const row = updateRes.rows[0];
    return {
      id: row.id,
      project_id: row.project_id,
      key: row.key,
      value: returnedValue,
      is_secret: row.is_secret,
      created_at: row.created_at.toISOString ? row.created_at.toISOString() : String(row.created_at),
      updated_at: row.updated_at.toISOString ? row.updated_at.toISOString() : String(row.updated_at),
    };
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      throw new EnvVarError("DUPLICATE_KEY", `Environment variable '${newKey}' already exists for this project`, 409);
    }
    throw error;
  }
}

export async function deleteProjectEnvVar(projectId: string, varId: string): Promise<boolean> {
  validateId(projectId, "project id");
  validateId(varId, "environment variable id");

  const result = await pool.query(
    `
    DELETE FROM project_env_vars
    WHERE id = $1 AND project_id = $2
    `,
    [varId, projectId]
  );

  return (result.rowCount ?? 0) > 0;
}
