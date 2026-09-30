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
  if (raw === undefined || raw === "") return undefined;
  return raw;
}

function normalizePrivateKey(raw: string): string {
  const withNewlines = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  return withNewlines.trim();
}

export function getGitHubConfig(): GitHubConfig {
  const appId = read("GITHUB_APP_ID");
  const privateKeyRaw = read("GITHUB_APP_PRIVATE_KEY");
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
    apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
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
      read("GITHUB_APP_PRIVATE_KEY") &&
      read("GITHUB_WEBHOOK_SECRET")
  );
}
