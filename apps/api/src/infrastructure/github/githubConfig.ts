const API_BASE_DEFAULT = "https://api.github.com";

export interface GitHubConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  apiBaseUrl: string;
  defaultInstallationId: string | null;
}

function read(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return trimmed;
}

export function normalizePrivateKey(raw: string): string {
  let trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  let key = trimmed.includes("\\n") ? trimmed.replace(/\\n/g, "\n") : trimmed;
  if (!key.includes("-----BEGIN")) {
    try {
      const decoded = Buffer.from(key, "base64").toString("utf8");
      if (decoded.includes("-----BEGIN")) {
        key = decoded;
      }
    } catch {
      // not base64, leave key as is
    }
  }
  return key.trim();
}

export function getGitHubConfig(): GitHubConfig {
  const appId = read("GITHUB_APP_ID");
  const privateKeyRaw =
    read("GITHUB_APP_PRIVATE_KEY") ?? read("GITHUB_APP_PRIVATE_KEY_BASE64");
  const webhookSecret = read("GITHUB_WEBHOOK_SECRET");
  if (!appId) throw new Error("Missing required env var GITHUB_APP_ID");
  if (!privateKeyRaw)
    throw new Error("Missing required env var GITHUB_APP_PRIVATE_KEY");
  if (!webhookSecret)
    throw new Error("Missing required env var GITHUB_WEBHOOK_SECRET");
  const apiBaseUrl =
    read("GITHUB_API_BASE_URL") ?? API_BASE_DEFAULT;
  return {
    appId,
    privateKey: normalizePrivateKey(privateKeyRaw),
    webhookSecret,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    defaultInstallationId: read("GITHUB_INSTALLATION_ID") ?? null,
  };
}

export function getWebhookSecret(): string {
  const secret = read("GITHUB_WEBHOOK_SECRET");
  if (!secret) throw new Error("Missing required env var GITHUB_WEBHOOK_SECRET");
  return secret;
}

export function isGitHubConfigured(): boolean {
  return Boolean(
    read("GITHUB_APP_ID") &&
      (read("GITHUB_APP_PRIVATE_KEY") || read("GITHUB_APP_PRIVATE_KEY_BASE64")) &&
      read("GITHUB_WEBHOOK_SECRET")
  );
}
