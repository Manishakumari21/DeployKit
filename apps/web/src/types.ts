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

export type DeployStatus = "ready" | "building" | "failed" | "queued";

export type Deployment = {
  id: string;
  projectId: string;
  projectName: string;
  status: DeployStatus;
  branch: string;
  commit: string;
  message: string;
  author: string;
  createdAt: string;
  duration: string;
  env: "production" | "preview";
};

export type Domain = {
  host: string;
  projectName: string;
  ssl: boolean;
  primary: boolean;
};
