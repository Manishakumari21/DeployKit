// Phase 12.4: strict job/image validation tests (no DB, no Docker).
import test from "node:test";
import assert from "node:assert/strict";

import {
  boundErrorCode,
  boundErrorMessage,
  EdgeJobSchemaError,
  MAX_ERROR_CODE_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  parseClaimedJobResponse,
  parseHeartbeatState,
  parseImageReference,
  redactForLog,
  toImageReference,
} from "./edgeJobSchema.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4434-8344-444444444444";
const GOOD_DIGEST = `sha256:${"a".repeat(64)}`;

function goodJob(): Record<string, unknown> {
  return {
    id: JOB_ID,
    deploymentId: DEPLOYMENT_ID,
    projectId: PROJECT_ID,
    agentId: AGENT_ID,
    attempts: 1,
    maxAttempts: 3,
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    branch: "main",
    commitSha: "b".repeat(40),
  };
}

test("parses the actual claim envelope shape", () => {
  const parsed = parseClaimedJobResponse({ job: goodJob() });
  assert.ok(parsed);
  assert.equal(parsed.id, JOB_ID);
  assert.equal(parsed.deploymentId, DEPLOYMENT_ID);
  assert.equal(parsed.projectId, PROJECT_ID);
  assert.equal(parsed.agentId, AGENT_ID);
  assert.equal(parsed.attempts, 1);
  assert.equal(parsed.maxAttempts, 3);
  assert.equal(parsed.branch, "main");
  assert.equal(parsed.commitSha, "b".repeat(40));
});

test("claim of null job means idle", () => {
  assert.equal(parseClaimedJobResponse({ job: null }), null);
});

test("rejects malformed claim envelopes and untrusted ids", () => {
  assert.throws(() => parseClaimedJobResponse(null), EdgeJobSchemaError);
  assert.throws(() => parseClaimedJobResponse({}), EdgeJobSchemaError);
  assert.throws(() => parseClaimedJobResponse({ job: 42 }), EdgeJobSchemaError);
  // Agent-supplied lookalike ids must not pass.
  for (const field of ["id", "deploymentId", "projectId", "agentId"] as const) {
    const mutated = goodJob();
    mutated[field] = "not-a-uuid";
    assert.throws(() => parseClaimedJobResponse({ job: mutated }), EdgeJobSchemaError, field);
  }
  // Negative/overflow attempts, bad lease, bad branch, bad sha.
  const badAttempts = goodJob(); badAttempts.attempts = -1;
  assert.throws(() => parseClaimedJobResponse({ job: badAttempts }), EdgeJobSchemaError);
  const badLease = goodJob(); badLease.leaseExpiresAt = "not-a-time";
  assert.throws(() => parseClaimedJobResponse({ job: badLease }), EdgeJobSchemaError);
  const badBranch = goodJob(); badBranch.branch = "main; rm -rf /";
  assert.throws(() => parseClaimedJobResponse({ job: badBranch }), EdgeJobSchemaError);
  const badSha = goodJob(); badSha.commitSha = "latest";
  assert.throws(() => parseClaimedJobResponse({ job: badSha }), EdgeJobSchemaError);
  // Null lease and null sha are legal (server may omit them).
  const nullable = goodJob(); nullable.leaseExpiresAt = null; nullable.commitSha = null;
  const parsed = parseClaimedJobResponse({ job: nullable });
  assert.ok(parsed);
  assert.equal(parsed.leaseExpiresAt, null);
  assert.equal(parsed.commitSha, null);
});

test("heartbeat state requires matching deployment ids", () => {
  const state = {
    job: { id: JOB_ID, deploymentId: DEPLOYMENT_ID, status: "running", attempts: 1, maxAttempts: 3, leaseExpiresAt: null },
    deployment: { id: DEPLOYMENT_ID, status: "cloning" },
  };
  const parsed = parseHeartbeatState(state);
  assert.equal(parsed.job.status, "running");
  assert.equal(parsed.deployment.status, "cloning");
  const mismatched = {
    job: state.job,
    deployment: { id: PROJECT_ID, status: "cloning" },
  };
  assert.throws(() => parseHeartbeatState(mismatched), EdgeJobSchemaError);
  assert.throws(() => parseHeartbeatState({ job: state.job }), EdgeJobSchemaError);
});

test("accepts immutable digest-pinned references", () => {
  const parsed = parseImageReference(`registry.local:5000/deploykit/project-abcdef12@${GOOD_DIGEST}`);
  assert.equal(parsed.repository, "registry.local:5000/deploykit/project-abcdef12");
  assert.equal(parsed.digest, GOOD_DIGEST);
  assert.equal(toImageReference(parsed), `registry.local:5000/deploykit/project-abcdef12@${GOOD_DIGEST}`);
  const localhostRef = parseImageReference(`localhost/deploykit/app@${GOOD_DIGEST}`);
  assert.equal(localhostRef.repository, "localhost/deploykit/app");
});

test("rejects local-only repositories without a registry host", () => {
  for (const ref of [
    `deploykit/project-local@${GOOD_DIGEST}`,
    `library/app@${GOOD_DIGEST}`,
  ]) {
    assert.throws(() => parseImageReference(ref), /registry host/, ref);
  }
});

test("rejects mutable image tags", () => {
  for (const ref of [
    "registry.local/deploykit/app:latest",
    "registry.local/deploykit/app:v1.2.3",
    `registry.local/deploykit/app:${"b".repeat(40)}`,
    "registry.local/deploykit/app",
    "deploykit/app:latest",
  ]) {
    assert.throws(() => parseImageReference(ref), /mutable tags|registry host prefix/, ref);
  }
});

test("rejects malformed digests and injection shapes", () => {
  for (const ref of [
    "registry.local/app@sha256:xyz",
    "registry.local/app@sha256:gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
    "registry.local/app@md5:d41d8cd98f00b204e9800998ecf8427e",
    "registry.local/app@sha256:aaa",
    "registry.local/app@",
    "https://registry.local/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "registry.local/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; rm -rf /",
    "registry.local/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`id`",
    "registry.local/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$(id)",
    "REGISTRY.LOCAL/APP@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "",
    42,
    null,
  ]) {
    assert.throws(() => parseImageReference(ref as string), EdgeJobSchemaError, String(ref));
  }
});

test("bounds error payloads to the failure-endpoint contract", () => {
  assert.ok(boundErrorCode("x".repeat(500), "FALLBACK").length <= MAX_ERROR_CODE_LENGTH);
  assert.equal(boundErrorCode("", "FALLBACK"), "FALLBACK");
  assert.equal(boundErrorCode("a\nb", "FALLBACK"), "a b");
  assert.ok(boundErrorMessage("y".repeat(9000), "FALLBACK").length <= MAX_ERROR_MESSAGE_LENGTH);
  assert.equal(boundErrorMessage("", "FALLBACK"), "FALLBACK");
});

test("redacts credentials from logs and payloads", () => {
  const token = "sekrit-agent-token-123";
  const msg = boundErrorMessage(`pull failed with Bearer ${token} denied`, "FALLBACK");
  assert.ok(!msg.includes(token), "token must not leak");
  assert.ok(msg.includes("[redacted]"));
  assert.ok(!redactForLog("password: hunter2 visible").includes("hunter2"));
});

test("claim image block: trusted digest reference parses, malformed fails closed", () => {
  const withImage = { ...(goodJob() as Record<string, unknown>) };
  const releaseId = "77777777-7777-4777-8777-777777777777";
  withImage.image = { repository: "registry.local:5000/deploykit/app", digest: GOOD_DIGEST, releaseId };
  const parsed = parseClaimedJobResponse({ job: withImage });
  assert.ok(parsed?.image);
  assert.equal(parsed?.image?.repository, "registry.local:5000/deploykit/app");
  assert.equal(parsed?.image?.digest, GOOD_DIGEST);
  assert.equal(parsed?.image?.releaseId, releaseId);

  // Null image (no trusted record) is legal and means fail-closed downstream.
  const withoutImage = parseClaimedJobResponse({ job: goodJob() });
  assert.equal(withoutImage?.image, null);

  // Malformed image blocks never validate: mutable tag, bad digest,
  // non-registry repository, bad release id.
  for (const image of [
    { repository: "registry.local:5000/deploykit/app:latest", digest: GOOD_DIGEST, releaseId: null },
    { repository: "registry.local:5000/deploykit/app", digest: "not-a-digest", releaseId: null },
    { repository: "local-only-name", digest: GOOD_DIGEST, releaseId: null },
    { repository: "registry.local:5000/deploykit/app", digest: GOOD_DIGEST, releaseId: "bogus" },
    "registry.local:5000/deploykit/app@sha256:zzz",
    42,
  ]) {
    const mutated = { ...(goodJob() as Record<string, unknown>), image };
    assert.throws(() => parseClaimedJobResponse({ job: mutated }), EdgeJobSchemaError, JSON.stringify(image));
  }
});
