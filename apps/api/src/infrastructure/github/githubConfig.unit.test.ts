import test from "node:test";
import assert from "node:assert/strict";
import {
  getGitHubConfig,
  getWebhookSecret,
  isGitHubConfigured,
  normalizePrivateKey,
} from "./githubConfig.js";

const envKeys = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_BASE64",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_API_BASE_URL",
  "GITHUB_INSTALLATION_ID",
] as const;

const original = new Map<string, string | undefined>();

function clearEnv(): void {
  for (const key of envKeys) {
    if (!original.has(key)) original.set(key, process.env[key]);
    delete process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  original.clear();
}

test("normalizePrivateKey unescapes literal backslash-n newlines", () => {
  const input = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA...\\n-----END RSA PRIVATE KEY-----";
  const normalized = normalizePrivateKey(input);
  assert.equal(
    normalized,
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"
  );
});

test("normalizePrivateKey strips outer double and single quotes", () => {
  const doubleQuoted = '"-----BEGIN RSA PRIVATE KEY-----\\nline\\n-----END RSA PRIVATE KEY-----"';
  assert.equal(
    normalizePrivateKey(doubleQuoted),
    "-----BEGIN RSA PRIVATE KEY-----\nline\n-----END RSA PRIVATE KEY-----"
  );

  const singleQuoted = "'-----BEGIN RSA PRIVATE KEY-----\\nline\\n-----END RSA PRIVATE KEY-----'";
  assert.equal(
    normalizePrivateKey(singleQuoted),
    "-----BEGIN RSA PRIVATE KEY-----\nline\n-----END RSA PRIVATE KEY-----"
  );
});

test("normalizePrivateKey decodes base64-encoded PEM keys", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nfake-key-content\n-----END RSA PRIVATE KEY-----";
  const base64 = Buffer.from(pem, "utf8").toString("base64");
  assert.equal(normalizePrivateKey(base64), pem);
});

test("isGitHubConfigured returns false when any required variable is empty or unset", () => {
  clearEnv();
  try {
    assert.equal(isGitHubConfigured(), false);

    process.env.GITHUB_APP_ID = "12345";
    assert.equal(isGitHubConfigured(), false);

    process.env.GITHUB_APP_PRIVATE_KEY = "pem";
    assert.equal(isGitHubConfigured(), false);

    // empty secret should still return false
    process.env.GITHUB_WEBHOOK_SECRET = "   ";
    assert.equal(isGitHubConfigured(), false);

    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    assert.equal(isGitHubConfigured(), true);
  } finally {
    restoreEnv();
  }
});

test("isGitHubConfigured supports GITHUB_APP_PRIVATE_KEY_BASE64 fallback", () => {
  clearEnv();
  try {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    process.env.GITHUB_APP_PRIVATE_KEY_BASE64 = "base64-key";
    assert.equal(isGitHubConfigured(), true);
  } finally {
    restoreEnv();
  }
});

test("getGitHubConfig parses config correctly with base64 private key fallback", () => {
  clearEnv();
  try {
    process.env.GITHUB_APP_ID = "  99999  ";
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nmykey\n-----END RSA PRIVATE KEY-----";
    process.env.GITHUB_APP_PRIVATE_KEY_BASE64 = Buffer.from(pem, "utf8").toString("base64");
    process.env.GITHUB_WEBHOOK_SECRET = "hook-sec";
    process.env.GITHUB_API_BASE_URL = "https://api.github.com///";

    const config = getGitHubConfig();
    assert.equal(config.appId, "99999");
    assert.equal(config.privateKey, pem);
    assert.equal(config.webhookSecret, "hook-sec");
    assert.equal(config.apiBaseUrl, "https://api.github.com");
    assert.equal(config.defaultInstallationId, null);
  } finally {
    restoreEnv();
  }
});

test("getWebhookSecret returns secret and throws if missing", () => {
  clearEnv();
  try {
    assert.throws(() => getWebhookSecret(), /Missing required env var GITHUB_WEBHOOK_SECRET/);
    process.env.GITHUB_WEBHOOK_SECRET = "sec123";
    assert.equal(getWebhookSecret(), "sec123");
  } finally {
    restoreEnv();
  }
});
