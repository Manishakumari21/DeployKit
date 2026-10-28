import test from "node:test";
import assert from "node:assert/strict";

import {
  __validateRepositoryUrlForTest as validateRepositoryUrl,
  ProjectError,
} from "./projectService.js";

function assertRejected(repositoryUrl: string, messageFragment: string) {
  try {
    validateRepositoryUrl(repositoryUrl);
    assert.fail(`expected ${repositoryUrl} to be rejected`);
  } catch (error) {
    assert.ok(error instanceof ProjectError);
    assert.equal((error as ProjectError).code, "INVALID_REPOSITORY_URL");
    assert.ok(
      (error as Error).message.includes(messageFragment),
      `expected message to mention ${messageFragment}`
    );
  }
}

test("accepts a normal HTTPS GitHub repository", () => {
  validateRepositoryUrl("https://github.com/acme/app.git");
});

test("rejects plain HTTP repositories", () => {
  assertRejected("http://github.com/acme/app.git", "HTTPS");
});

test("rejects embedded credentials", () => {
  assertRejected(
    "https://user:secret@github.com/acme/app.git",
    "credentials"
  );
});

test("rejects query parameters", () => {
  assertRejected("https://github.com/acme/app.git?ref=main", "query");
});

test("rejects URL fragments", () => {
  assertRejected("https://github.com/acme/app.git#frag", "fragments");
});

test("rejects custom ports", () => {
  assertRejected("https://github.com:8443/acme/app.git", "port");
});

test("rejects repositories without owner and name", () => {
  assertRejected("https://github.com/acme", "owner and repository");
});

test("rejects values that are not URLs", () => {
  assertRejected("github.com/acme/app.git", "valid URL");
});
