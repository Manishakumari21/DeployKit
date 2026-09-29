import test from "node:test";
import assert from "node:assert/strict";

import {
  SourceCheckoutError,
  validateBranch,
  validateRepositoryUrl,
} from "./sourceCheckout.js";

test("accepts an allowed GitHub repository", () => {
  const url = validateRepositoryUrl(
    "https://github.com/Manishakumari21/DeployKit.git"
  );

  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "github.com");
});

test("rejects non-HTTPS repositories", () => {
  assert.throws(
    () => validateRepositoryUrl(
      "http://github.com/Manishakumari21/DeployKit.git"
    ),
    (error: unknown) =>
      error instanceof SourceCheckoutError &&
      error.code === "UNSUPPORTED_REPOSITORY_PROTOCOL"
  );
});

test("rejects embedded credentials", () => {
  assert.throws(
    () => validateRepositoryUrl(
      "https://user:password@github.com/example/repo.git"
    ),
    (error: unknown) =>
      error instanceof SourceCheckoutError &&
      error.code === "REPOSITORY_CREDENTIALS_FORBIDDEN"
  );
});

test("rejects disallowed hosts", () => {
  assert.throws(
    () => validateRepositoryUrl(
      "https://example.com/example/repo.git"
    ),
    (error: unknown) =>
      error instanceof SourceCheckoutError &&
      error.code === "REPOSITORY_HOST_NOT_ALLOWED"
  );
});

test("rejects local file repositories", () => {
  assert.throws(
    () => validateRepositoryUrl(
      "file:///tmp/repository"
    ),
    (error: unknown) =>
      error instanceof SourceCheckoutError &&
      error.code === "UNSUPPORTED_REPOSITORY_PROTOCOL"
  );
});

test("accepts a normal branch name", () => {
  assert.equal(validateBranch("main"), "main");
  assert.equal(
    validateBranch("feature/deployment-engine"),
    "feature/deployment-engine"
  );
});

test("rejects dangerous branch values", () => {
  const invalidBranches = [
    "",
    " ",
    "-main",
    "feature..test",
    "feature/@{bad}",
    "feature\\test",
    "feature/",
    "feature.",
  ];

  for (const branch of invalidBranches) {
    assert.throws(
      () => validateBranch(branch),
      (error: unknown) =>
        error instanceof SourceCheckoutError &&
        error.code === "INVALID_BRANCH"
    );
  }
});
