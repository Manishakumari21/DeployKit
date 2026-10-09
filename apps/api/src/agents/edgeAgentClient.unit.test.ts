// Phase 12.4: control-plane client tests (stubbed fetch; no network).
import test from "node:test";
import assert from "node:assert/strict";

import {
  EdgeAgentClient,
  EdgeApiDefinitiveError,
  EdgeApiTransientError,
} from "./edgeAgentClient.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("rejects bad constructor input", () => {
  assert.throws(() => new EdgeAgentClient({ baseUrl: "not a url", token: "t" }), /base URL/);
  assert.throws(() => new EdgeAgentClient({ baseUrl: "http://cp:3000/api", token: "t" }), /without a path/);
  assert.throws(() => new EdgeAgentClient({ baseUrl: "http://cp:3000", token: "" }), /token is required/);
  assert.throws(() => new EdgeAgentClient({ baseUrl: "http://cp:3000", token: "a b" }), /whitespace/);
  assert.throws(() => new EdgeAgentClient({ baseUrl: "http://cp:3000", token: "t", requestTimeoutMs: 5 }), /timeout/);
});

test("claim posts with bearer auth and returns the envelope", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const client = new EdgeAgentClient({
    baseUrl: "http://cp:3000/",
    token: "agent-token-xyz",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return jsonResponse(200, { job: null });
    }) as typeof fetch,
  });
  const body = await client.claimJob();
  assert.deepEqual(body, { job: null });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://cp:3000/api/agent/jobs/claim");
  const headers = seen[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer agent-token-xyz");
});

test("classifies revocation and lease loss as definitive", async () => {
  for (const status of [401, 403, 404, 409]) {
    const client = new EdgeAgentClient({
      baseUrl: "http://cp:3000",
      token: "t",
      fetchImpl: (async () => jsonResponse(status, { error: "nope" })) as typeof fetch,
    });
    await assert.rejects(client.heartbeatJob("job-id"), EdgeApiDefinitiveError, `status ${status}`);
  }
});

test("classifies network failure, timeout, and 5xx as transient (never rejection)", async () => {
  const networkDown = new EdgeAgentClient({
    baseUrl: "http://cp:3000",
    token: "t",
    fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
  });
  await assert.rejects(networkDown.claimJob(), EdgeApiTransientError);

  const serverError = new EdgeAgentClient({
    baseUrl: "http://cp:3000",
    token: "t",
    fetchImpl: (async () => jsonResponse(503, { error: "boom" })) as typeof fetch,
  });
  await assert.rejects(serverError.failJob("j", "E", "m"), EdgeApiTransientError);

  const hanging = new EdgeAgentClient({
    baseUrl: "http://cp:3000",
    token: "t",
    requestTimeoutMs: 1000,
    fetchImpl: (((_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as unknown) as typeof fetch,
  });
  await assert.rejects(hanging.claimJob(), EdgeApiTransientError);
});

test("never leaks the token in transient error text", async () => {
  const token = "super-secret-agent-token";
  const client = new EdgeAgentClient({
    baseUrl: "http://cp:3000",
    token,
    fetchImpl: (async () => { throw new Error(`socket hangup with Bearer ${token} attached`); }) as typeof fetch,
  });
  try {
    await client.claimJob();
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(error instanceof EdgeApiTransientError);
    assert.ok(!error.message.includes(token), "token leaked into error text");
  }
});

test("complete/fail payloads match the server contract", async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const client = new EdgeAgentClient({
    baseUrl: "http://cp:3000",
    token: "t",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return jsonResponse(200, { ok: true });
    }) as typeof fetch,
  });
  await client.completeJob("job-1", { imageDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", commitSha: "b".repeat(40) });
  await client.failJob("job-1", "EDGE_X", "broken");
  assert.equal(seen[0].url, "http://cp:3000/api/agent/jobs/job-1/complete");
  assert.deepEqual(seen[0].body, {
    outcome: "succeeded",
    imageDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    commitSha: "b".repeat(40),
  });
  assert.equal(seen[1].url, "http://cp:3000/api/agent/jobs/job-1/fail");
  assert.deepEqual(seen[1].body, { errorCode: "EDGE_X", errorMessage: "broken" });
});
