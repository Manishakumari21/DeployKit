import test from "node:test";
import assert from "node:assert/strict";
import {
  getGitHubConnection,
  listGitHubRepositories,
  recordGitHubInstallation,
  GitHubConnectionError,
} from "./githubConnectionService.js";

const envKeys = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_API_BASE_URL",
  "GITHUB_INSTALLATION_ID",
] as const;

const original = new Map<string, string | undefined>();

function clearGitHubEnv(): void {
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

test("reports GitHub as not configured without App credentials", async () => {
  clearGitHubEnv();
  try {
    const connection = await getGitHubConnection(
      "11111111-1111-4111-8111-111111111111",
      "http://localhost:3001/api/github/callback"
    );
    assert.equal(connection.configured, false);
    assert.equal(connection.installUrl, null);
    assert.equal(connection.callbackUrl, "http://localhost:3001/api/github/callback");
    assert.match(connection.error ?? "", /not configured/i);
  } finally {
    restoreEnv();
  }
});

test("refuses to list repositories when GitHub is not configured", async () => {
  clearGitHubEnv();
  try {
    await assert.rejects(
      () => listGitHubRepositories(),
      (error: unknown) =>
        error instanceof GitHubConnectionError &&
        error.code === "GITHUB_NOT_CONFIGURED" &&
        error.status === 503
    );
  } finally {
    restoreEnv();
  }
});

test("rejects an invalid installation ID before touching the database", async () => {
  await assert.rejects(
    () => recordGitHubInstallation("not-an-installation"),
    (error: unknown) =>
      error instanceof GitHubConnectionError && error.code === "INVALID_INSTALLATION"
  );
});
