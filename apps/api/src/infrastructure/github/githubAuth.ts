import { createPrivateKey, sign } from "node:crypto";
import { getGitHubConfig } from "./githubConfig.js";

export class GitHubAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GitHubAuthError";
    this.code = code;
  }
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();
const pending = new Map<string, Promise<string>>();

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createGitHubAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSec = Math.floor(Date.now() / 1000)
): string {
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new GitHubAuthError("INVALID_PRIVATE_KEY", "Invalid GitHub App private key");
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new GitHubAuthError("INVALID_PRIVATE_KEY", "GitHub App private key must be RSA");
  }
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 600, iss: appId })
  );
  const data = `${header}.${payload}`;
  let signature: Buffer;
  try {
    signature = sign("sha256", Buffer.from(data), key);
  } catch {
    throw new GitHubAuthError("JWT_SIGN_FAILED", "Failed to sign GitHub App JWT");
  }
  return `${data}.${base64url(signature)}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestInstallationToken(
  apiBaseUrl: string,
  installationId: string,
  jwt: string
): Promise<{ token: string; expiresAt: number }> {
  const normalizedId = installationId.trim();
  if (!/^\d{1,20}$/.test(normalizedId)) {
    throw new GitHubAuthError("INVALID_INSTALLATION_ID", "Invalid installation ID");
  }
  const url = `${apiBaseUrl}/app/installations/${normalizedId}/access_tokens`;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
      10_000
    );
  } catch (error) {
    throw new GitHubAuthError("TOKEN_REQUEST_FAILED", error instanceof Error ? "GitHub token request failed" : "GitHub token request failed");
  }
  if (res.status === 401 || res.status === 403) {
    throw new GitHubAuthError("INSTALLATION_AUTH_FAILED", "GitHub installation not authorized");
  }
  if (res.status === 404) {
    throw new GitHubAuthError("INSTALLATION_NOT_FOUND", "GitHub installation not found");
  }
  if (res.status === 429) {
    throw new GitHubAuthError("RATE_LIMITED", "GitHub API rate limited");
  }
  if (!res.ok) {
    throw new GitHubAuthError("TOKEN_REQUEST_FAILED", `GitHub token request failed (${res.status})`);
  }
  const text = await res.text();
  if (text.length > 64 * 1024) {
    throw new GitHubAuthError("TOKEN_RESPONSE_TOO_LARGE", "GitHub token response too large");
  }
  let body: { token?: unknown; expires_at?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw new GitHubAuthError("TOKEN_RESPONSE_INVALID", "Invalid GitHub token response");
  }
  if (typeof body.token !== "string" || !body.token) {
    throw new GitHubAuthError("TOKEN_RESPONSE_INVALID", "Invalid GitHub token response");
  }
  const expiresAt =
    typeof body.expires_at === "string"
      ? Date.parse(body.expires_at)
      : Date.now() + 60 * 60 * 1000;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new GitHubAuthError("TOKEN_RESPONSE_INVALID", "Invalid token expiry");
  }
  return { token: body.token, expiresAt };
}

export async function getInstallationToken(installationId: string): Promise<string> {
  const config = getGitHubConfig();
  const key = installationId.trim();
  const cached = cache.get(key);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const task = (async () => {
    const jwt = createGitHubAppJwt(config.appId, config.privateKey);
    const { token, expiresAt } = await requestInstallationToken(
      config.apiBaseUrl,
      key,
      jwt
    );
    cache.set(key, { token, expiresAt });
    return token;
  })();
  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

export function __clearGitHubAuthCache(): void {
  cache.clear();
  pending.clear();
}
