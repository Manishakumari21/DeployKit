export type Project = {
  id: string;
  name: string;
  repository_url: string;
  branch: string;
  created_at: string;
  parent_project_id?: string | null;
  pr_number?: number | null;
  is_preview?: boolean;
  auto_deploy?: boolean;
  preview_deployments_enabled?: boolean;
};

export type AuthUser = {
  id: string;
  email: string;
  role: "admin" | "member";
  created_at: string;
  updated_at: string;
};

export type NavKey =
  | "overview"
  | "services"
  | "deployments"
  | "releases"
  | "build"
  | "github"
  | "servers"
  | "events"
  | "incidents"
  | "domains"
  | "logs"
  | "users"
  | "settings";

export type RegistrationStatus = {
  hasUsers: boolean;
  mode: "bootstrap" | "public" | "invite";
};

export type AdminUser = {
  id: string;
  email: string;
  role: "admin" | "member";
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export type Invite = {
  id: string;
  email: string;
  status: InviteStatus;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};

export type DeploymentStatus =
  | "queued"
  | "cloning"
  | "building"
  | "pushing"
  | "deploying"
  | "verifying"
  | "active"
  | "failed"
  | "cancelled";

export type DeployStatus = DeploymentStatus;

export const TERMINAL_STATUSES: DeploymentStatus[] = ["active", "failed", "cancelled"];

export function isTerminalStatus(s: DeploymentStatus): boolean {
  return s === "active" || s === "failed" || s === "cancelled";
}

export function isCancellableStatus(s: DeploymentStatus): boolean {
  return !isTerminalStatus(s);
}

export type ApiDeployment = {
  id: string;
  project_id: string;
  status: DeploymentStatus;
  trigger: "manual" | "github_push" | "github_pull_request" | "rollback";
  branch: string;
  commit_sha: string | null;
  image_repository: string | null;
  image_digest: string | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  job_status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | null;
  job_attempts?: number | null;
  max_attempts?: number | null;
  project_name?: string;
};

export type DeploymentEvent = {
  id: number;
  deployment_id: string;
  event_type: string;
  status_from: DeploymentStatus | null;
  status_to: DeploymentStatus | null;
  message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type ReleaseStatus = "pending" | "starting" | "healthy" | "active" | "stopped" | "failed";

export type Release = {
  id: string;
  deployment_id: string;
  project_id: string;
  image_repository: string;
  image_digest: string;
  status: ReleaseStatus;
  supersedes_release_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  healthy_at: string | null;
  activated_at: string | null;
  stopped_at: string | null;
};

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

export type ProjectEvent = {
  id: string;
  deployment_id: string;
  event_type: string;
  status_from: DeploymentStatus | null;
  status_to: DeploymentStatus | null;
  message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  branch: string;
  commit_sha: string | null;
  trigger: "manual" | "github_push" | "github_pull_request" | "rollback";
};

export type IncidentKind =
  | "deployment_failure"
  | "runtime_unhealthy"
  | "gateway_sync_failed"
  | "tls_failure"
  | "webhook_failed";

export type IncidentStatus = "open" | "acknowledged" | "resolved";

export type Incident = {
  id: string;
  project_id: string;
  kind: IncidentKind;
  subject_key: string;
  status: IncidentStatus;
  severity: "warning" | "critical";
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
};

export type IncidentStatusFilter = "active" | "open" | "acknowledged" | "resolved" | "all";

export type GitHubConnection = {
  configured: boolean;
  installUrl: string | null;
  callbackUrl: string;
  error: string | null;
};

export type GitHubLink = {
  project_id: string;
  linked: boolean;
  auto_deploy?: boolean;
  branch?: string | null;
  repository_id?: string | null;
  full_name?: string | null;
  private?: boolean | null;
  installation_id?: string | null;
};

export type GitHubRepository = {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  installationId: string;
};

export type GitHubRepositoriesResponse = {
  repositories: GitHubRepository[];
  truncated: boolean;
  failed: number;
};

export type GitHubSelection = {
  installationId: string;
  repositoryFullName: string;
  repositoryId?: number;
};

export type ProjectEnvVar = {
  id: string;
  project_id: string;
  key: string;
  value: string;
  is_secret: boolean;
  created_at: string;
  updated_at: string;
};

export type AgentStatus = "pending" | "online" | "offline" | "revoked";

export type ProjectAgent = {
  id: string;
  projectId: string;
  name: string;
  status: AgentStatus;
  lastHeartbeatAt: string | null;
  version: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EnrolledAgentResponse = {
  agent: ProjectAgent;
  credential: {
    id: string;
    token: string;
    expiresAt: string | null;
  };
  installCommand: string;
};
