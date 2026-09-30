import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  createGitHubAppJwt,
  getInstallationToken,
  __clearGitHubAuthCache,
  GitHubAuthError,
} from "./githubAuth.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function setEnv(): void {
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = PEM;
  process.env.GITHUB_WEBHOOK_SECRET = "s";
  process.env.GITHUB_API_BASE_URL = "http://127.0.0.1:9";
}

test("creates a well-formed RS256 JWT", () => {
  const jwt = createGitHubAppJwt("12345", PEM, 1_700_000_000);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  assert.equal(header.alg, "RS256");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  assert.equal(payload.iss, "12345");
  assert.ok(payload.exp - payload.iat <= 660);
});

test("rejects a non-RSA private key", () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }).toString();
  assert.throws(() => createGitHubAppJwt("1", ec), (error: unknown) => error instanceof GitHubAuthError);
});

test("caches the installation token until expiry", async () => {
  setEnv();
  __clearGitHubAuthCache();
  const original = globalThis.fetch;
  let calls = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ token: `tok-${calls}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }),
      { status: 201 }
    );
  }) as typeof fetch;
  try {
    const first = await getInstallationToken("999");
    const second = await getInstallationToken("999");
    assert.equal(first, second);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    __clearGitHubAuthCache();
  }
});

test("refreshes an expired token", async () => {
  setEnv();
  __clearGitHubAuthCache();
  const original = globalThis.fetch;
  let calls = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    calls++;
    const expires =
      calls === 1
        ? new Date(Date.now() - 1000).toISOString()
        : new Date(Date.now() + 3600_000).toISOString();
    return new Response(JSON.stringify({ token: `tok-${calls}`, expires_at: expires }), {
      status: 201,
    });
  }) as typeof fetch;
  try {
    const first = await getInstallationToken("1000");
    const second = await getInstallationToken("1000");
    assert.notEqual(first, second);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    __clearGitHubAuthCache();
  }
});

test("maps 401 without leaking the token", async () => {
  setEnv();
  __clearGitHubAuthCache();
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async () =>
    new Response("denied", { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(getInstallationToken("1001"), (error: unknown) => {
      assert.ok(error instanceof GitHubAuthError);
      assert.ok(!(error as Error).message.includes("Bearer"));
      return true;
    });
  } finally {
    globalThis.fetch = original;
    __clearGitHubAuthCache();
  }
});
