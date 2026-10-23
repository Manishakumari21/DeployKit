import test from "node:test";
import assert from "node:assert/strict";
import {
  createGitHubState,
  verifyGitHubState,
  GitHubStateError,
} from "./githubState.js";

const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;

function withSecret(): void {
  process.env.GITHUB_WEBHOOK_SECRET = "test-state-secret";
}

function restoreSecret(): void {
  if (originalSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
}

test("creates and verifies a signed GitHub state", () => {
  withSecret();
  try {
    const now = Date.now();
    const state = createGitHubState("user-1", now);
    const verified = verifyGitHubState(state, now + 1000);
    assert.equal(verified.userId, "user-1");
  } finally {
    restoreSecret();
  }
});

test("rejects a tampered GitHub state", () => {
  withSecret();
  try {
    const state = createGitHubState("user-1");
    const tampered = `${state.slice(0, -1)}${state.endsWith("a") ? "b" : "a"}`;
    assert.throws(
      () => verifyGitHubState(tampered),
      (error: unknown) => error instanceof GitHubStateError
    );
  } finally {
    restoreSecret();
  }
});

test("rejects an expired GitHub state", () => {
  withSecret();
  try {
    const now = Date.now();
    const state = createGitHubState("user-1", now - 11 * 60 * 1000);
    assert.throws(
      () => verifyGitHubState(state, now),
      (error: unknown) =>
        error instanceof GitHubStateError && error.code === "STATE_EXPIRED"
    );
  } finally {
    restoreSecret();
  }
});

test("rejects malformed GitHub state", () => {
  withSecret();
  try {
    assert.throws(
      () => verifyGitHubState(""),
      (error: unknown) => error instanceof GitHubStateError
    );
    assert.throws(
      () => verifyGitHubState("not-a-state"),
      (error: unknown) => error instanceof GitHubStateError
    );
  } finally {
    restoreSecret();
  }
});
