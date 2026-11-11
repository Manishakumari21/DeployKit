import type {
  BuildConfig,
  BuildConfigResponse,
  DetectionResponse,
  SavedBuildConfigResponse,
} from "./buildConfig";
import type {
  AdminUser,
  ApiDeployment,
  AuthUser,
  DeploymentEvent,
  GitHubConnection,
  GitHubLink,
  GitHubRepositoriesResponse,
  GitHubSelection,
  Incident,
  IncidentKind,
  IncidentStatusFilter,
  Invite,
  Project,
  ProjectAgent,
  EnrolledAgentResponse,
  ProjectEnvVar,
  ProjectEvent,
  RegistrationStatus,
  Release,
} from "../types";

export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "/api";

export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function json(res: Response) {
  return res.json().catch(() => ({}));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {

    res = await fetch(`${API_URL}${path}`, { credentials: "include", ...init });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error("Could not reach the API", { cause: e });
  }
  const data = await json(res);
  if (!res.ok) {
    throw new ApiError(
      data.error || `Request failed (${res.status})`,
      res.status,
      typeof data.code === "string" ? data.code : null
    );
  }
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

export async function register(input: {
  email: string;
  password: string;
  inviteToken?: string;
}): Promise<AuthUser> {
  return request<AuthUser>("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function logout(): Promise<void> {
  await request<{ loggedOut: boolean }>("/auth/logout", { method: "POST" });
}

export function fetchRegistrationStatus(signal?: AbortSignal): Promise<RegistrationStatus> {
  return request<RegistrationStatus>("/auth/registration-status", { signal });
}

export function fetchUsers(signal?: AbortSignal): Promise<AdminUser[]> {
  return request<{ users: AdminUser[] }>("/users", { signal }).then((d) => d.users);
}

export function setUserDisabled(id: string, disabled: boolean): Promise<AdminUser> {
  return request<{ user: AdminUser }>(`/users/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disabled }),
  }).then((d) => d.user);
}

export function fetchInvites(signal?: AbortSignal): Promise<Invite[]> {
  return request<{ invites: Invite[] }>("/invites", { signal }).then((d) => d.invites);
}

export function createInvite(email: string): Promise<{ invite: Invite; token: string }> {
  return request<{ invite: Invite; token: string }>("/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export function revokeInvite(id: string): Promise<Invite> {
  return request<{ invite: Invite }>(`/invites/${id}`, { method: "DELETE" }).then(
    (d) => d.invite
  );
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

export async function updateProject(
  id: string,
  input: { name?: string; branch?: string }
): Promise<Project> {
  return request<Project>(`/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function fetchProjectEnvVars(projectId: string, signal?: AbortSignal): Promise<ProjectEnvVar[]> {
  return request<ProjectEnvVar[]>(`/projects/${projectId}/env-vars`, { signal });
}

export async function createProjectEnvVar(
  projectId: string,
  input: { key: string; value: string; isSecret?: boolean }
): Promise<ProjectEnvVar> {
  return request<ProjectEnvVar>(`/projects/${projectId}/env-vars`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateProjectEnvVar(
  projectId: string,
  varId: string,
  input: { key?: string; value?: string; isSecret?: boolean }
): Promise<ProjectEnvVar> {
  return request<ProjectEnvVar>(`/projects/${projectId}/env-vars/${varId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteProjectEnvVar(projectId: string, varId: string): Promise<void> {
  await request<{ message: string }>(`/projects/${projectId}/env-vars/${varId}`, {
    method: "DELETE",
  });
}

export async function revealProjectEnvVar(
  projectId: string,
  varId: string
): Promise<{ id: string; key: string; value: string }> {
  return request<{ id: string; key: string; value: string }>(
    `/projects/${projectId}/env-vars/${varId}/reveal`
  );
}

export function fetchProjectAgents(projectId: string, signal?: AbortSignal): Promise<ProjectAgent[]> {
  return request<ProjectAgent[]>(`/projects/${projectId}/agents`, { signal });
}

export function enrollProjectAgent(
  projectId: string,
  name: string,
  expiresAt?: string
): Promise<EnrolledAgentResponse> {
  return request<EnrolledAgentResponse>(`/projects/${projectId}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, expiresAt }),
  });
}

export function revokeProjectAgent(
  projectId: string,
  agentId: string
): Promise<{ message: string }> {
  return request<{ message: string }>(`/projects/${projectId}/agents/${agentId}`, {
    method: "DELETE",
  });
}

export function fetchGitHubConnection(signal?: AbortSignal): Promise<GitHubConnection> {
  return request<GitHubConnection>("/github/connection", { signal });
}

export function fetchGitHubRepositories(
  pageOrSignal?: number | AbortSignal,
  signal?: AbortSignal
): Promise<GitHubRepositoriesResponse> {
  const page = typeof pageOrSignal === "number" ? pageOrSignal : 1;
  const actualSignal = pageOrSignal instanceof AbortSignal ? pageOrSignal : signal;
  return request<GitHubRepositoriesResponse>(
    `/github/repositories?page=${encodeURIComponent(String(page))}`,
    { signal: actualSignal }
  );
}

export function fetchProjectGithubLink(
  projectId: string,
  signal?: AbortSignal
): Promise<GitHubLink> {
  return request<GitHubLink>(`/projects/${projectId}/github-link`, { signal });
}

export function unlinkProjectGithub(projectId: string): Promise<unknown> {
  return request(`/projects/${projectId}/github-link`, { method: "DELETE" });
}

export function linkProjectGithub(
  projectId: string,
  input: GitHubSelection & { autoDeploy?: boolean }
): Promise<unknown> {
  return request(`/projects/${projectId}/github-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, autoDeploy: input.autoDeploy ?? true }),
  });
}

export function fetchProjectEvents(
  projectId: string,
  limit = 50,
  signal?: AbortSignal
): Promise<ProjectEvent[]> {
  return request<ProjectEvent[]>(`/projects/${projectId}/events?limit=${limit}`, {
    signal,
  });
}

export function fetchIncidents(
  projectId: string,
  params: { status?: IncidentStatusFilter; kind?: IncidentKind; limit?: number } = {},
  signal?: AbortSignal
): Promise<Incident[]> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.kind) query.set("kind", params.kind);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const qs = query.toString();
  return request<Incident[]>(
    `/projects/${projectId}/incidents${qs ? `?${qs}` : ""}`,
    { signal }
  );
}

export function fetchIncident(
  projectId: string,
  incidentId: string,
  signal?: AbortSignal
): Promise<Incident> {
  return request<Incident>(`/projects/${projectId}/incidents/${incidentId}`, {
    signal,
  });
}

export function acknowledgeIncident(
  projectId: string,
  incidentId: string
): Promise<Incident> {
  return request<Incident>(
    `/projects/${projectId}/incidents/${incidentId}/acknowledge`,
    { method: "POST" }
  );
}

export function resolveIncident(
  projectId: string,
  incidentId: string
): Promise<Incident> {
  return request<Incident>(`/projects/${projectId}/incidents/${incidentId}/resolve`, {
    method: "POST",
  });
}

export function fetchBuildConfig(
  projectId: string,
  signal?: AbortSignal
): Promise<BuildConfigResponse> {
  return request<BuildConfigResponse>(`/projects/${projectId}/build-config`, { signal });
}

export function saveBuildConfig(
  projectId: string,
  config: BuildConfig
): Promise<SavedBuildConfigResponse> {
  return request<SavedBuildConfigResponse>(`/projects/${projectId}/build-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

export function resetBuildConfig(projectId: string): Promise<{ config: null }> {
  return request<{ config: null }>(`/projects/${projectId}/build-config`, {
    method: "DELETE",
  });
}

export function detectProject(
  projectId: string,
  signal?: AbortSignal
): Promise<DetectionResponse> {
  return request<DetectionResponse>(`/projects/${projectId}/detect`, {
    method: "POST",
    signal,
  });
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

export function fetchReleases(projectId: string, signal?: AbortSignal): Promise<Release[]> {
  return request<Release[]>(`/projects/${projectId}/releases`, { signal });
}

export function rollbackDeployment(
  projectId: string,
  releaseId: string,
  idempotencyKey: string
): Promise<ApiDeployment> {
  return request<ApiDeployment>(`/projects/${projectId}/rollback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ releaseId }),
  });
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
  tls_requested_at: string | null;
  tls_last_attempt_at: string | null;
  tls_last_error_code: string | null;
  tls_last_error: string | null;
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

export function requestDomainCertificate(domainId: string): Promise<CustomDomain> {
  return request<CustomDomain>(`/domains/${domainId}/certificate`, { method: "POST" });
}
