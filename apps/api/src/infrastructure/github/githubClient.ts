import { getGitHubConfig } from "./githubConfig.js";
import { getInstallationToken } from "./githubAuth.js";

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

const MAX_BODY_BYTES = 512 * 1024;

async function readBounded(res: Response): Promise<string> {
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
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

export async function getRepository(
  installationId: string,
  fullName: string
): Promise<{ id: number; full_name: string; private: boolean; default_branch: string }> {
  const parts = fullName.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GitHubApiError("INVALID_REPO", "Invalid repository full name");
  }
  const config = getGitHubConfig();
  // Token stays in the Authorization header; never interpolated into errors.
  const token = await getInstallationToken(installationId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${config.apiBaseUrl}/repos/${parts[0]}/${parts[1]}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
    mapStatus(res);
    const text = await readBounded(res);
    let body: { id: number; full_name: string; private: boolean; default_branch: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new GitHubApiError("INVALID_RESPONSE", "Invalid GitHub API response", res.status);
    }
    return body;
  } catch (error) {
    if (error instanceof GitHubApiError) throw error;
    throw new GitHubApiError("REQUEST_FAILED", "GitHub API request failed");
  } finally {
    clearTimeout(timer);
  }
}
