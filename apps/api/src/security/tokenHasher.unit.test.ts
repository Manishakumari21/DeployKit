import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  TOKEN_PEPPER_ENV,
  hashSecret,
  resetTokenPepperCache,
  tokenPepperSource,
} from "../security/tokenHasher.js";

const savedPepper = process.env[TOKEN_PEPPER_ENV];

test.after(() => {
  if (savedPepper === undefined) delete process.env[TOKEN_PEPPER_ENV];
  else process.env[TOKEN_PEPPER_ENV] = savedPepper;
  resetTokenPepperCache();
});

test("stored token hashes are keyed, not plain sha256", () => {
  process.env[TOKEN_PEPPER_ENV] = "test-pepper-value";
  resetTokenPepperCache();
  const token = "a-plain-text-token";
  const stored = hashSecret(token);
  const unsalted = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  assert.notEqual(stored, unsalted, "token hashes must not be unsalted sha256");
  assert.equal(stored.length, 64);
  assert.equal(tokenPepperSource(), "env");
});

test("a different pepper produces a different hash for the same token", () => {
  process.env[TOKEN_PEPPER_ENV] = "pepper-one";
  resetTokenPepperCache();
  const first = hashSecret("same-token");
  process.env[TOKEN_PEPPER_ENV] = "pepper-two";
  resetTokenPepperCache();
  const second = hashSecret("same-token");
  assert.notEqual(first, second, "a database dump must not be replayable without the pepper");
});

test("an unconfigured pepper falls back to an ephemeral per-process key", () => {
  delete process.env[TOKEN_PEPPER_ENV];
  resetTokenPepperCache();
  const first = hashSecret("same-token");
  assert.equal(tokenPepperSource(), "ephemeral");
  resetTokenPepperCache();
  const second = hashSecret("same-token");
  assert.notEqual(first, second, "an ephemeral pepper must not survive a restart");
});
