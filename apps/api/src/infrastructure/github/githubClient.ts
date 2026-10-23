import { getGitHubConfig } from "./githubConfig.js";
import { createGitHubAppJwt, getInstallationToken } from "./githubAuth.js";

export class GitHubApiError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "GitHubApiError";
    this.code = code;
    this.status = status;
  }
}

export interface GitHubAppInfo {
  slug: string;
  name: string;
  htmlUrl: string;
}

export interface GitHubRepository {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
}

export interface GitHubRepositoryList {
  repositories: GitHubRepository[];
  truncated: boolean;
}

const MAX_BODY_BYTES = 512 * 1024;
const MAX_LIST_BODY_BYTES = 2 * 1024 * 1024;

async function readBounded(res: Response, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new GitHubApiError("RESPONSE_TOO_LARGE", "GitHub response too large", res.status);
  }
  return text;
}

function mapStatus(res: Response): void {
  if (res.status === 401 || res.status === 403) {
    throw new GitHubApiError("FORBIDDEN", "GitHub API forbidden", res.status);
  }
  if (res.status === 404) {
    throw new GitHubApiError("NOT_FOUND", "GitHub resource not found", 404);
  }
  if (res.status === 429) {
    throw new GitHubApiError("RATE_LIMITED", "GitHub API rate limited", 429);
  }
  if (!res.ok) {
    throw new GitHubApiError("REQUEST_FAILED", `GitHub API error (${res.status})`, res.status);
  }
}

async function githubJson<T>(
  url: string,
  init: RequestInit,
  maxBytes = MAX_BODY_BYTES
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    mapStatus(res);
    const text = await readBounded(res, maxBytes);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GitHubApiError("INVALID_RESPONSE", "Invalid GitHub API response", res.status);
    }
  } catch (error) {
    if (error instanceof GitHubApiError) throw error;
    throw new GitHubApiError("REQUEST_FAILED", "GitHub API request failed");
  } finally {
    clearTimeout(timer);
  }
}

function parseRepository(raw: unknown): GitHubRepository | null {
  if (typeof raw !== "object" || raw === null) return null;
  const repo = raw as Record<string, unknown>;
  if (
    typeof repo.id !== "number" ||
    !Number.isSafeInteger(repo.id) ||
    repo.id <= 0 ||
    typeof repo.full_name !== "string" ||
    !repo.full_name.includes("/") ||
    typeof repo.html_url !== "string" ||
    !/^https?:\/\//.test(repo.html_url)
  ) {
    return null;
  }
  const ownerRaw =
    typeof repo.owner === "object" && repo.owner !== null
      ? (repo.owner as Record<string, unknown>).login
      : null;
  const fallbackOwner = repo.full_name.split("/")[0];
  return {
    id: repo.id,
    fullName: repo.full_name,
    name:
      typeof repo.name === "string" && repo.name
        ? repo.name
        : repo.full_name.split("/").pop() ?? repo.full_name,
    owner: typeof ownerRaw === "string" && ownerRaw ? ownerRaw : fallbackOwner,
    private: repo.private === true,
    htmlUrl: repo.html_url,
    cloneUrl:
      typeof repo.clone_url === "string" && repo.clone_url ? repo.clone_url : repo.html_url,
    defaultBranch:
      typeof repo.default_branch === "string" && repo.default_branch
        ? repo.default_branch
        : "main",
  };
}

export async function getGitHubAppInfo(): Promise<GitHubAppInfo> {
  const config = getGitHubConfig();
  const jwt = createGitHubAppJwt(config.appId, config.privateKey);
  const body = await githubJson<{ slug?: unknown; name?: unknown; html_url?: unknown }>(
    `${config.apiBaseUrl}/app`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (
    typeof body.slug !== "string" ||
    !body.slug ||
    typeof body.html_url !== "string" ||
    !/^https?:\/\//.test(body.html_url)
  ) {
    throw new GitHubApiError("INVALID_RESPONSE", "Invalid GitHub App response");
  }
  return {
    slug: body.slug,
    name: typeof body.name === "string" && body.name ? body.name : body.slug,
    htmlUrl: body.html_url,
  };
}

export async function listInstallationRepositories(
  installationId: string
): Promise<GitHubRepositoryList> {
  const config = getGitHubConfig();
  const token = await getInstallationToken(installationId);
  const body = await githubJson<{ total_count?: unknown; repositories?: unknown }>(
    `${config.apiBaseUrl}/installation/repositories?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
    MAX_LIST_BODY_BYTES
  );
  if (!Array.isArray(body.repositories)) {
    throw new GitHubApiError("INVALID_RESPONSE", "Invalid GitHub repository response");
  }
  const repositories = body.repositories
    .map(parseRepository)
    .filter((repo): repo is GitHubRepository => repo !== null);
  const totalCount =
    typeof body.total_count === "number" && Number.isFinite(body.total_count)
      ? body.total_count
      : repositories.length;
  return { repositories, truncated: totalCount > repositories.length };
}

export async function getRepository(
  installationId: string,
  fullName: string
): Promise<{ id: number; full_name: string; private: boolean; default_branch: string }> {
  const parts = fullName.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GitHubApiError("INVALID_REPO", "Invalid repository full name");
  }
  const config = getGitHubConfig();
  const token = await getInstallationToken(installationId);
  return githubJson<{ id: number; full_name: string; private: boolean; default_branch: string }>(
    `${config.apiBaseUrl}/repos/${parts[0]}/${parts[1]}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
}
