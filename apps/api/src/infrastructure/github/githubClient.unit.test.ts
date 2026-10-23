import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { __clearGitHubAuthCache } from "./githubAuth.js";
import { getGitHubAppInfo, listInstallationRepositories } from "./githubClient.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function setEnv(): void {
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = PEM;
  process.env.GITHUB_WEBHOOK_SECRET = "s";
  process.env.GITHUB_API_BASE_URL = "https://api.github.test";
}

test("reads GitHub App metadata", async () => {
  setEnv();
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async () =>
    new Response(
      JSON.stringify({
        slug: "deploykit",
        name: "DeployKit",
        html_url: "https://github.com/apps/deploykit",
      }),
      { status: 200 }
    )) as typeof fetch;
  try {
    const app = await getGitHubAppInfo();
    assert.equal(app.slug, "deploykit");
    assert.equal(app.name, "DeployKit");
    assert.equal(app.htmlUrl, "https://github.com/apps/deploykit");
  } finally {
    globalThis.fetch = original;
  }
});

test("lists installation repositories and drops malformed entries", async () => {
  setEnv();
  __clearGitHubAuthCache();
  const original = globalThis.fetch;
  let calls = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async (...args: Parameters<typeof fetch>) => {
    calls += 1;
    const url = String(args[0]);
    if (url.endsWith("/access_tokens")) {
      return new Response(
        JSON.stringify({
          token: "installation-token",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 201 }
      );
    }
    return new Response(
      JSON.stringify({
        total_count: 2,
        repositories: [
          {
            id: 42,
            full_name: "acme/website",
            name: "website",
            owner: { login: "acme" },
            private: true,
            html_url: "https://github.com/acme/website",
            clone_url: "https://github.com/acme/website.git",
            default_branch: "main",
          },
          { id: "not-a-number", full_name: "bad" },
        ],
      }),
      { status: 200 }
    );
  }) as typeof fetch;
  try {
    const result = await listInstallationRepositories("123");
    assert.equal(calls, 2);
    assert.equal(result.repositories.length, 1);
    assert.equal(result.repositories[0].fullName, "acme/website");
    assert.equal(result.repositories[0].owner, "acme");
    assert.equal(result.repositories[0].private, true);
    assert.equal(result.repositories[0].defaultBranch, "main");
    assert.equal(result.truncated, true);
  } finally {
    globalThis.fetch = original;
    __clearGitHubAuthCache();
  }
});
