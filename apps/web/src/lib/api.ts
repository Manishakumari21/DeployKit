import type { ApiDeployment, DeploymentEvent, Project } from "../types";

export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "/api";

async function json(res: Response) {
  return res.json().catch(() => ({}));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error("Could not reach the API", { cause: e });
  }
  const data = await json(res);
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${API_URL}/projects`);
  const data = await json(res);
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await json(res);
  if (!res.ok) throw new Error(data.error || "Failed to create project");
  return data as Project;
}

export async function deleteProject(id: string) {
  await fetch(`${API_URL}/projects/${id}`, { method: "DELETE" });
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
