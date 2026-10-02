export type Project = {
  id: string;
  name: string;
  repository_url: string;
  branch: string;
  created_at: string;
};

export type NavKey =
  | "overview"
  | "services"
  | "deployments"
  | "domains"
  | "logs"
  | "settings";
 
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
  trigger: "manual" | "github_push" | "rollback";
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
