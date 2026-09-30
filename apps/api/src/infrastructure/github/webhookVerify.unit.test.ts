import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifyGitHubSignature,
  WebhookVerifyError,
} from "./webhookVerify.js";

const SECRET = "test-webhook-secret";

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("accepts a valid signature", () => {
  const body = Buffer.from('{"ref":"refs/heads/main"}');
  verifyGitHubSignature(body, sign(body), SECRET);
});

test("rejects missing signature", () => {
  assert.throws(() => verifyGitHubSignature(Buffer.from("{}"), undefined, SECRET), (
    error: unknown
  ) => error instanceof WebhookVerifyError && error.code === "MISSING_SIGNATURE");
});

test("rejects malformed signatures", () => {
  for (const bad of ["", "sha256=", "sha256=xyz", "md5=abc", "sha256=" + "a".repeat(63)]) {
    assert.throws(() => verifyGitHubSignature(Buffer.from("{}"), bad, SECRET), (
      error: unknown
    ) => error instanceof WebhookVerifyError && error.code === "MALFORMED_SIGNATURE");
  }
});

test("rejects wrong secret", () => {
  const body = Buffer.from("{}");
  assert.throws(() => verifyGitHubSignature(body, sign(body, "other"), SECRET), (
    error: unknown
  ) => error instanceof WebhookVerifyError && error.code === "INVALID_SIGNATURE");
});

test("rejects tampered body", () => {
  const body = Buffer.from('{"a":1}');
  const sig = sign(body);
  assert.throws(() => verifyGitHubSignature(Buffer.from('{"a":2}'), sig, SECRET), (
    error: unknown
  ) => error instanceof WebhookVerifyError && error.code === "INVALID_SIGNATURE");
});

test("does not parse before verifying (raw bytes matter)", () => {
  const body = Buffer.from('{"a":1} ');
  const sig = sign(Buffer.from('{"a":1}'));
  assert.throws(() => verifyGitHubSignature(body, sig, SECRET), (
    error: unknown
  ) => error instanceof WebhookVerifyError);
});
