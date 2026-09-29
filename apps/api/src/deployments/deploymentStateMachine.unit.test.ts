import test from "node:test";
import assert from "node:assert/strict";

import {
  assertTransition,
  canTransition,
  isTerminal,
} from "./deploymentStateMachine.js";

test("allows the happy-path pipeline", () => {
  const path = [
    "queued",
    "cloning",
    "building",
    "verifying",
    "deploying",
    "active",
  ] as const;
  for (let i = 0; i < path.length - 1; i++) {
    assert.equal(canTransition(path[i], path[i + 1]), true);
  }
});

test("rejects skipping stages and backward moves", () => {
  assert.equal(canTransition("queued", "building"), false);
  assert.equal(canTransition("building", "cloning"), false);
  assert.equal(canTransition("active", "queued"), false);
  assert.equal(canTransition("cancelled", "queued"), false);
});

test("supports retry and cancel paths", () => {
  assert.equal(canTransition("building", "queued"), true);
  assert.equal(canTransition("failed", "queued"), true);
  assert.equal(canTransition("queued", "cancelled"), true);
  assert.equal(canTransition("deploying", "cancelled"), true);
});

test("assertTransition throws on invalid moves", () => {
  assert.throws(
    () => assertTransition("active", "queued"),
    /Invalid deployment transition/
  );
});

test("building must go through verifying, never straight to deploying", () => {
  // Rollback and build paths share deployRelease, which requires
  // verifying -> deploying. This pins the linear pipeline shape.
  assert.equal(canTransition("building", "deploying"), false);
  assert.equal(canTransition("building", "verifying"), true);
  assert.equal(canTransition("verifying", "deploying"), true);
  assert.equal(canTransition("queued", "active"), false);
});

test("terminal detection", () => {
  assert.equal(isTerminal("active"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("cancelled"), true);
  assert.equal(isTerminal("building"), false);
});
