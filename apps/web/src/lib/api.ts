import type { ApiDeployment, AuthUser, DeploymentEvent, Project } from "../types";

export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "/api";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function json(res: Response) {
  return res.json().catch(() => ({}));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // Cookies carry the session; always send them (same-origin by default,
    // cross-origin when VITE_API_URL points at the API directly).
    res = await fetch(`${API_URL}${path}`, { credentials: "include", ...init });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error("Could not reach the API", { cause: e });
  }
  const data = await json(res);
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data as T;
}

export async function fetchSession(): Promise<AuthUser> {
  const data = await request<{ user: AuthUser }>("/auth/session");
  return data.user;
}

export async function login(input: { email: string; password: string }): Promise<AuthUser> {
  return request<AuthUser>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function register(input: { email: string; password: string }): Promise<AuthUser> {
  return request<AuthUser>("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function logout(): Promise<void> {
  await request<{ loggedOut: boolean }>("/auth/logout", { method: "POST" });
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${API_URL}/projects`, { credentials: "include" });
  const data = await json(res);
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return Array.isArray(data) ? data : [];
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function createProject(input: {
  name: string;
  repositoryUrl: string;
  branch: string;
}): Promise<Project> {
  const res = await fetch(`${API_URL}/projects`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await json(res);
  if (!res.ok) throw new ApiError(data.error || "Failed to create project", res.status);
  return data as Project;
}

export async function deleteProject(id: string) {
  const res = await fetch(`${API_URL}/projects/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  const data = await json(res);
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
}

export function fetchDeployments(projectId: string): Promise<ApiDeployment[]> {
  return request<ApiDeployment[]>(`/projects/${projectId}/deployments`);
}

export function createDeployment(projectId: string, idempotencyKey: string): Promise<ApiDeployment> {
  return request<ApiDeployment>(`/projects/${projectId}/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ trigger: "manual" }),
  });
}

export function fetchDeployment(deploymentId: string, signal?: AbortSignal): Promise<ApiDeployment> {
  return request<ApiDeployment>(`/deployments/${deploymentId}`, { signal });
}

export function fetchDeploymentEvents(deploymentId: string): Promise<DeploymentEvent[]> {
  return request<DeploymentEvent[]>(`/deployments/${deploymentId}/events`);
}

export function cancelDeployment(deploymentId: string): Promise<{ id: string; status: string }> {
  return request(`/deployments/${deploymentId}/cancel`, { method: "POST" });
}

export type DeploymentLog = {
  id: string;
  deployment_id: string;
  source: string;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type LogsResponse = {
  items: DeploymentLog[];
  next_cursor: string | null;
  truncated: boolean;
};

export function fetchDeploymentLogs(
  deploymentId: string,
  params: { cursor?: string | null; limit?: number; source?: string; level?: string; direction?: "asc" | "desc" } = {},
  signal?: AbortSignal,
): Promise<LogsResponse> {
  const q = new URLSearchParams();
  if (params.cursor) q.set("cursor", params.cursor);
  if (params.limit) q.set("limit", String(params.limit));
  if (params.source) q.set("source", params.source);
  if (params.level) q.set("level", params.level);
  if (params.direction) q.set("direction", params.direction);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return request<LogsResponse>(`/deployments/${deploymentId}/logs${suffix}`, { signal });
}

export type ProjectMetrics = {
  project_id: string;
  deployments: {
    total: number;
    successful: number;
    failed: number;
    cancelled: number;
    success_rate: number | null;
    avg_duration_seconds: number | null;
    build_count: number;
    build_failures: number;
    avg_build_duration_seconds: number | null;
  };
  queue: { queued: number; running: number; failed: number; succeeded: number; total_retries: number };
  runtime: { active_releases: number; healthy_runtimes: number; unhealthy_runtimes: number };
  worker: { enabled: boolean; poll_interval_ms: number; lease_ms: number; last_activity_at: string | null };
};

export function fetchProjectMetrics(projectId: string, signal?: AbortSignal): Promise<ProjectMetrics> {
  return request<ProjectMetrics>(`/projects/${projectId}/metrics`, { signal });
}

export type CustomDomain = {
  id: string;
  project_id: string;
  domain: string;
  status: "pending" | "verifying" | "verified" | "failed" | "removed";
  verification: { type: "dns-txt"; name: string; value?: string };
  verified_at: string | null;
  tls_status: "none" | "pending" | "issued" | "renewing" | "failed" | "expired";
  cert_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export function fetchDomains(projectId: string): Promise<CustomDomain[]> {
  return request<CustomDomain[]>(`/projects/${projectId}/domains`);
}

export function createDomain(projectId: string, domain: string): Promise<CustomDomain> {
  return request<CustomDomain>(`/projects/${projectId}/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain }),
  });
}

export function verifyDomain(domainId: string): Promise<CustomDomain> {
  return request<CustomDomain>(`/domains/${domainId}/verify`, { method: "POST" });
}

export function deleteDomain(domainId: string): Promise<{ removed: boolean; id: string }> {
  return request<{ removed: boolean; id: string }>(`/domains/${domainId}`, {
    method: "DELETE",
  });
}
