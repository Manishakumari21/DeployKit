

import { redactForLog } from "./edgeJobSchema.js";

export type FetchImpl = typeof fetch;

export class EdgeApiDefinitiveError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "EdgeApiDefinitiveError";
    this.code = code;
    this.status = status;
  }
}

export class EdgeApiTransientError extends Error {
  readonly code = "EDGE_API_TRANSIENT";
  constructor(message: string) {
    super(message);
    this.name = "EdgeApiTransientError";
  }
}

export interface EdgeAgentClientOptions {
  baseUrl: string;
  token: string;

  requestTimeoutMs?: number;
  fetchImpl?: FetchImpl;
}

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 15_000;

function normalizeBaseUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/i.test(value)) {
    throw new Error("Edge agent base URL must be http(s)://host[:port] without a path");
  }
  return value;
}

function normalizeTimeout(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(raw) || raw < MIN_TIMEOUT_MS || raw > MAX_TIMEOUT_MS) {
    throw new Error(`Edge agent request timeout must be ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS} ms`);
  }
  return raw;
}

export interface EdgeCompletionPayload {
  imageDigest?: string;
  commitSha?: string;
}

export class EdgeAgentClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(options: EdgeAgentClientOptions) {
    if (typeof options.token !== "string" || options.token.length === 0) {
      throw new Error("Edge agent token is required");
    }
    if (/\s/.test(options.token)) {
      throw new Error("Edge agent token must not contain whitespace");
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token;
    this.requestTimeoutMs = normalizeTimeout(options.requestTimeoutMs);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async claimJob(signal?: AbortSignal): Promise<unknown> {
    const body = await this.post("/api/agent/jobs/claim", undefined, signal);
    return body;
  }

  async heartbeatJob(jobId: string, signal?: AbortSignal): Promise<unknown> {
    return this.post(`/api/agent/jobs/${encodeURIComponent(jobId)}/heartbeat`, undefined, signal);
  }

  async completeJob(jobId: string, payload: EdgeCompletionPayload, signal?: AbortSignal): Promise<unknown> {
    return this.post(`/api/agent/jobs/${encodeURIComponent(jobId)}/complete`, {
      outcome: "succeeded",
      ...(payload.imageDigest !== undefined ? { imageDigest: payload.imageDigest } : {}),
      ...(payload.commitSha !== undefined ? { commitSha: payload.commitSha } : {}),
    }, signal);
  }

  async failJob(jobId: string, errorCode: string, errorMessage: string, signal?: AbortSignal): Promise<unknown> {
    return this.post(`/api/agent/jobs/${encodeURIComponent(jobId)}/fail`, {
      errorCode,
      errorMessage,
    }, signal);
  }

  private async post(path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      throw new EdgeApiTransientError("Edge agent request was cancelled before send");
    }
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = signal === undefined
      ? timeout
      : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method: "POST",
        headers: {

          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new EdgeApiTransientError("Edge agent request was cancelled");
      }

      throw new EdgeApiTransientError(
        `Control-plane request failed without a response: ${redactForLog(error instanceof Error ? error.message : "unknown error").slice(0, 300)}`
      );
    }
    if (response.status === 401) {
      throw new EdgeApiDefinitiveError("EDGE_AGENT_UNAUTHORIZED", "Agent token rejected (revoked, expired, or invalid)", 401);
    }
    if (response.status === 403) {
      throw new EdgeApiDefinitiveError("EDGE_LEASE_NOT_OWNED", "Job belongs to another project, agent, or the agent is revoked", 403);
    }
    if (response.status === 404) {
      throw new EdgeApiDefinitiveError("EDGE_JOB_NOT_FOUND", "Job or agent no longer exists", 404);
    }
    if (response.status === 409) {
      throw new EdgeApiDefinitiveError("EDGE_LEASE_STALE", "Job lease is no longer active", 409);
    }
    if (response.status >= 500) {
      throw new EdgeApiTransientError(`Control-plane error (status ${response.status}); outcome unknown, reconcile before retrying`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new EdgeApiDefinitiveError("EDGE_API_REJECTED", `Control-plane rejected the request (status ${response.status})`, response.status);
    }
    const text = await response.text().catch(() => "");
    if (text.trim().length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new EdgeApiDefinitiveError("EDGE_API_BAD_RESPONSE", "Control-plane returned a non-JSON response", response.status);
    }
  }
}
