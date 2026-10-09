// Phase 12.5: edge agent configuration and validation.
//
// All values come from the process environment. Everything required is
// validated at startup; the runner refuses to start on any missing,
// malformed, insecure, or contradictory value (fail closed, exit code 2).
//
// Security rules enforced here:
//   - Control-plane URL must be a bare http(s) origin (no path, query, or
//     userinfo, so credentials can never hide in the URL).
//   - HTTPS is required for non-local hosts. Plain HTTP is permitted only
//     for loopback hosts, or with the explicit local-dev opt-in
//     DEPLOYKIT_EDGE_ALLOW_HTTP (compose-internal hostnames such as `api`).
//   - TLS verification cannot be disabled: there is no such option, unknown
//     TLS-bypass knobs are rejected, and NODE_TLS_REJECT_UNAUTHORIZED=0
//     fails startup.
//   - The agent token is never echoed in errors, logs, or diagnostics.
//   - No shell commands or Docker arguments are accepted from configuration.
//   - Numeric settings are bounded; no default image exists anywhere here,
//     so the executor's fail-closed image contract cannot be bypassed.

import { z } from "zod";

export class EdgeAgentConfigError extends Error {
  readonly code = "EDGE_AGENT_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "EdgeAgentConfigError";
  }
}

export const EXIT_CONFIG = 2;
export const EXIT_PREFLIGHT = 3;
export const EXIT_REVOKED = 4;

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type EdgeLogLevel = (typeof LOG_LEVELS)[number];

export interface EdgeAgentConfig {
  controlPlaneUrl: string;
  agentToken: string;
  agentId: string | null;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  heartbeatIntervalMs: number;
  executionTimeoutMs: number;
  dockerBinary: string;
  networkName: string;
  memoryBytes: number | undefined;
  cpuLimit: number | undefined;
  pidsLimit: number | undefined;
  containerPort: number | undefined;
  healthPath: string | undefined;
  healthTimeoutMs: number | undefined;
  logLevel: EdgeLogLevel;
}

function intEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  def: number,
  min: number,
  max: number
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new EdgeAgentConfigError(
      `${name} must be an integer ${min}..${max}`
    );
  }
  return parsed;
}

function optionalIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  min: number,
  max: number
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new EdgeAgentConfigError(
      `${name} must be an integer ${min}..${max}`
    );
  }
  return parsed;
}

function isTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new EdgeAgentConfigError(
    "DEPLOYKIT_EDGE_ALLOW_HTTP must be true/false (or 1/0)"
  );
}

function parseControlPlaneUrl(raw: unknown, allowHttp: boolean): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new EdgeAgentConfigError("DEPLOYKIT_CONTROL_PLANE_URL is required");
  }
  const value = raw.trim();
  if (/[\s'"`$\\]/.test(value)) {
    throw new EdgeAgentConfigError("DEPLOYKIT_CONTROL_PLANE_URL contains illegal characters");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EdgeAgentConfigError(
      "DEPLOYKIT_CONTROL_PLANE_URL must be an absolute http(s) URL"
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EdgeAgentConfigError(
      "DEPLOYKIT_CONTROL_PLANE_URL must use http or https"
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new EdgeAgentConfigError(
      "DEPLOYKIT_CONTROL_PLANE_URL must not embed credentials"
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new EdgeAgentConfigError(
      "DEPLOYKIT_CONTROL_PLANE_URL must be a bare origin without a path"
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new EdgeAgentConfigError(
      "DEPLOYKIT_CONTROL_PLANE_URL must not include query or fragment"
    );
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(host) && !allowHttp) {
    throw new EdgeAgentConfigError(
      "Plain HTTP is permitted only for local control planes (localhost, 127.0.0.1, ::1, host.docker.internal) " +
        "or with the documented local-development opt-in DEPLOYKIT_EDGE_ALLOW_HTTP=true"
    );
  }
  return `${url.protocol}//${url.host}`;
}

// The agent token is a 256-bit opaque credential (64 hex chars at issuance).
// Minimum-length + whitespace checks here; the value itself is never echoed.
function parseAgentToken(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") {
    throw new EdgeAgentConfigError("DEPLOYKIT_AGENT_TOKEN is required");
  }
  if (/\s/.test(raw) || raw.length < 16 || raw.length > 512) {
    throw new EdgeAgentConfigError("DEPLOYKIT_AGENT_TOKEN is malformed");
  }
  return raw;
}

const agentIdSchema = z.string().uuid();

export function parseEdgeAgentConfig(
  env: NodeJS.ProcessEnv = process.env
): EdgeAgentConfig {
  // TLS verification cannot be disabled: refuse to run under knobs that
  // would silently downgrade every control-plane connection.
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new EdgeAgentConfigError(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification and is forbidden for the edge agent"
    );
  }
  for (const knob of ["DEPLOYKIT_EDGE_INSECURE_TLS", "DEPLOYKIT_EDGE_TLS_INSECURE"]) {
    if (env[knob] !== undefined && env[knob] !== "") {
      throw new EdgeAgentConfigError(
        `${knob} is not a supported setting; TLS verification cannot be disabled`
      );
    }
  }

  const allowHttp = isTruthy(env.DEPLOYKIT_EDGE_ALLOW_HTTP);
  const controlPlaneUrl = parseControlPlaneUrl(
    env.DEPLOYKIT_CONTROL_PLANE_URL,
    allowHttp
  );
  const agentToken = parseAgentToken(env.DEPLOYKIT_AGENT_TOKEN);

  let agentId: string | null = null;
  const rawAgentId = env.DEPLOYKIT_AGENT_ID;
  if (rawAgentId !== undefined && rawAgentId.trim() !== "") {
    const parsed = agentIdSchema.safeParse(rawAgentId.trim());
    if (!parsed.success) {
      throw new EdgeAgentConfigError("DEPLOYKIT_AGENT_ID must be a UUID");
    }
    agentId = parsed.data;
  }

  const rawLevel = (env.DEPLOYKIT_LOG_LEVEL ?? "info").trim().toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(rawLevel)) {
    throw new EdgeAgentConfigError(
      "DEPLOYKIT_LOG_LEVEL must be debug, info, warn, or error"
    );
  }

  const dockerBinary = (env.DEPLOYKIT_DOCKER_BINARY ?? "docker").trim();
  if (
    dockerBinary === "" ||
    dockerBinary.length > 256 ||
    /[\s'"`$\\]/.test(dockerBinary)
  ) {
    throw new EdgeAgentConfigError("DEPLOYKIT_DOCKER_BINARY is malformed");
  }
  const networkName = (
    env.DEPLOYKIT_EDGE_NETWORK ?? "deploykit-runtime"
  ).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(networkName)) {
    throw new EdgeAgentConfigError("DEPLOYKIT_EDGE_NETWORK is malformed");
  }

  const healthPathRaw = env.DEPLOYKIT_EDGE_HEALTH_PATH;
  const healthPath =
    healthPathRaw === undefined || healthPathRaw.trim() === ""
      ? undefined
      : healthPathRaw.trim();
  if (
    healthPath !== undefined &&
    (!healthPath.startsWith("/") || healthPath.length > 1024 || /[\r\n]/.test(healthPath))
  ) {
    throw new EdgeAgentConfigError("DEPLOYKIT_EDGE_HEALTH_PATH is malformed");
  }

  return {
    controlPlaneUrl,
    agentToken,
    agentId,
    pollIntervalMs: intEnv(env, "DEPLOYKIT_EDGE_POLL_INTERVAL_MS", 5_000, 1_000, 60_000),
    requestTimeoutMs: intEnv(env, "DEPLOYKIT_EDGE_REQUEST_TIMEOUT_MS", 15_000, 1_000, 120_000),
    heartbeatIntervalMs: intEnv(env, "DEPLOYKIT_EDGE_HEARTBEAT_INTERVAL_MS", 10_000, 1_000, 60_000),
    executionTimeoutMs: intEnv(env, "DEPLOYKIT_EDGE_EXECUTION_TIMEOUT_MS", 600_000, 30_000, 3_600_000),
    dockerBinary,
    networkName,
    memoryBytes: optionalIntEnv(env, "DEPLOYKIT_EDGE_MEMORY_BYTES", 64 * 1024 * 1024, 8 * 1024 * 1024 * 1024),
    cpuLimit: optionalIntEnv(env, "DEPLOYKIT_EDGE_CPU_LIMIT", 1, 16),
    pidsLimit: optionalIntEnv(env, "DEPLOYKIT_EDGE_PIDS_LIMIT", 16, 4096),
    containerPort: optionalIntEnv(env, "DEPLOYKIT_EDGE_CONTAINER_PORT", 1, 65535),
    healthPath,
    healthTimeoutMs: optionalIntEnv(env, "DEPLOYKIT_EDGE_HEALTH_TIMEOUT_MS", 5_000, 300_000),
    logLevel: rawLevel as EdgeLogLevel,
  };
}
