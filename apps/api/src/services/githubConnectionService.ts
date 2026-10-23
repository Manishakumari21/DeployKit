import pool from "../db/database.js";
import {
  getGitHubAppInfo,
  listInstallationRepositories,
  type GitHubRepository,
} from "../infrastructure/github/githubClient.js";
import { isGitHubConfigured } from "../infrastructure/github/githubConfig.js";
import { createGitHubState } from "../infrastructure/github/githubState.js";

export class GitHubConnectionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "GitHubConnectionError";
    this.code = code;
    this.status = status;
  }
}

export interface GitHubConnection {
  configured: boolean;
  installUrl: string | null;
  callbackUrl: string;
  error: string | null;
}

export interface ConnectedGitHubRepository extends GitHubRepository {
  installationId: string;
}

export interface GitHubRepositoryResponse {
  repositories: ConnectedGitHubRepository[];
  truncated: boolean;
  failed: number;
}

function appInstallUrl(htmlUrl: string): string {
  return `${htmlUrl.replace(/\/+$/, "")}/installations/new`;
}

export async function getGitHubConnection(
  userId: string,
  callbackUrl: string
): Promise<GitHubConnection> {
  if (!isGitHubConfigured()) {
    return {
      configured: false,
      installUrl: null,
      callbackUrl,
      error:
        "GitHub is not configured on this instance. Set the GitHub App credentials before connecting.",
    };
  }
  try {
    const app = await getGitHubAppInfo();
    const state = createGitHubState(userId);
    return {
      configured: true,
      installUrl: `${appInstallUrl(app.htmlUrl)}?state=${encodeURIComponent(state)}`,
      callbackUrl,
      error: null,
    };
  } catch {
    return {
      configured: true,
      installUrl: null,
      callbackUrl,
      error: "The GitHub App could not be reached. Check the app credentials and try again.",
    };
  }
}

export async function listGitHubRepositories(): Promise<GitHubRepositoryResponse> {
  if (!isGitHubConfigured()) {
    throw new GitHubConnectionError(
      "GITHUB_NOT_CONFIGURED",
      "GitHub is not configured on this instance.",
      503
    );
  }
  const installations = await pool.query(
    `SELECT github_installation_id FROM github_installations ORDER BY created_at ASC`
  );
  if (installations.rowCount === 0) {
    throw new GitHubConnectionError(
      "GITHUB_NOT_CONNECTED",
      "Connect GitHub before choosing a repository.",
      404
    );
  }
  const repositories: ConnectedGitHubRepository[] = [];
  let truncated = false;
  let failed = 0;
  for (const row of installations.rows) {
    const installationId = String(row.github_installation_id);
    try {
      const result = await listInstallationRepositories(installationId);
      repositories.push(
        ...result.repositories.map((repo) => ({ ...repo, installationId }))
      );
      truncated = truncated || result.truncated;
    } catch {
      failed += 1;
    }
  }
  if (repositories.length === 0) {
    throw new GitHubConnectionError(
      "GITHUB_NO_REPOSITORIES",
      failed > 0
        ? "The connected GitHub App could not list repositories. Reconnect GitHub and try again."
        : "No repositories are available to this GitHub App installation.",
      404
    );
  }
  return { repositories, truncated, failed };
}

export async function recordGitHubInstallation(installationId: string): Promise<void> {
  const normalized = String(installationId ?? "").trim();
  if (!/^\d{1,20}$/.test(normalized)) {
    throw new GitHubConnectionError("INVALID_INSTALLATION", "Invalid installation ID");
  }
  await pool.query(
    `INSERT INTO github_installations (github_installation_id)
     VALUES ($1)
     ON CONFLICT (github_installation_id) DO NOTHING`,
    [normalized]
  );
}
