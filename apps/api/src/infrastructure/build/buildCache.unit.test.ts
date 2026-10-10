import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILD_CACHE_TAG,
  buildBuildxArgs,
  BuildExecutorError,
  selectCacheRef,
  shouldRetryWithoutCache,
  validateImageTag,
} from "./buildxBuildExecutor.js";
import { DEFAULT_BUILD_POLICY, getBuildPolicy } from "./buildPolicy.js";

const REPO_A = "localhost:5000/deploykit/project-aaaaaaaa";
const REPO_B = "localhost:5000/deploykit/project-bbbbbbbb";

function baseArgs(push: boolean, cacheRef?: string | null) {
  return buildBuildxArgs({
    builder: "deploykit-builder",
    imageReference: `${REPO_A}:d-test`,
    commitSha: "a".repeat(40),
    policy: { ...DEFAULT_BUILD_POLICY },
    push,
    cacheRef,
  });
}

test("registry builds with a cache ref import and export project cache", () => {
  const ref = `${REPO_A}:${BUILD_CACHE_TAG}`;
  const args = baseArgs(true, ref);
  assert.ok(args.includes("--push"));
  const fromIndex = args.indexOf("--cache-from");
  assert.notEqual(fromIndex, -1);
  assert.equal(args[fromIndex + 1], `type=registry,ref=${ref}`);
  const toIndex = args.indexOf("--cache-to");
  assert.notEqual(toIndex, -1);
  assert.equal(args[toIndex + 1], `type=registry,ref=${ref},mode=max`);
});

test("local builds never carry cache flags", () => {
  const args = baseArgs(false, `${REPO_A}:${BUILD_CACHE_TAG}`);
  assert.ok(args.includes("--load"));
  assert.ok(!args.includes("--cache-from"));
  assert.ok(!args.includes("--cache-to"));
});

test("builds without a cache ref are unchanged", () => {
  for (const args of [baseArgs(true), baseArgs(true, null), baseArgs(false)]) {
    assert.ok(!args.includes("--cache-from"));
    assert.ok(!args.includes("--cache-to"));
  }
});

test("malformed cache references are rejected", () => {
  assert.throws(() => baseArgs(true, "not-a-ref"), BuildExecutorError);
  assert.throws(() => baseArgs(true, `${REPO_A}:BAD TAG!`), BuildExecutorError);
});

test("cache selection is project-scoped and honors policy", () => {
  const a = selectCacheRef({
    push: true,
    cacheEnabled: true,
    imageRepository: REPO_A,
    cacheTag: BUILD_CACHE_TAG,
  });
  const b = selectCacheRef({
    push: true,
    cacheEnabled: true,
    imageRepository: REPO_B,
    cacheTag: BUILD_CACHE_TAG,
  });
  assert.equal(a, `${REPO_A}:${BUILD_CACHE_TAG}`);
  assert.equal(b, `${REPO_B}:${BUILD_CACHE_TAG}`);
  assert.notEqual(a, b);
  assert.equal(
    selectCacheRef({ push: true, cacheEnabled: false, imageRepository: REPO_A, cacheTag: BUILD_CACHE_TAG }),
    null
  );
  assert.equal(
    selectCacheRef({ push: false, cacheEnabled: true, imageRepository: REPO_A, cacheTag: BUILD_CACHE_TAG }),
    null
  );
  assert.equal(
    selectCacheRef({ push: true, cacheEnabled: true, imageRepository: REPO_A, cacheTag: null }),
    null
  );
  assert.throws(
    () =>
      selectCacheRef({ push: true, cacheEnabled: true, imageRepository: REPO_A, cacheTag: "bad tag!" }),
    BuildExecutorError
  );
});

test("cache fallback retries only failed executions, never cancel or timeout", () => {
  const failed = new BuildExecutorError("BUILD_FAILED", "nope");
  const execFailed = new BuildExecutorError("BUILD_EXECUTION_FAILED", "nope");
  const timeout = new BuildExecutorError("BUILD_TIMEOUT", "slow");
  const cancelled = new BuildExecutorError("BUILD_CANCELLED", "stop");
  assert.equal(shouldRetryWithoutCache(failed, true, false), true);
  assert.equal(shouldRetryWithoutCache(execFailed, true, false), true);
  assert.equal(shouldRetryWithoutCache(timeout, true, false), false);
  assert.equal(shouldRetryWithoutCache(cancelled, true, false), false);
  assert.equal(shouldRetryWithoutCache(failed, true, true), false);
  assert.equal(shouldRetryWithoutCache(failed, false, false), false);
  assert.equal(shouldRetryWithoutCache(new Error("boom"), true, false), false);
});

test("release tags stay digest-pinned and cache tag is never a release identity", () => {
  assert.equal(validateImageTag(BUILD_CACHE_TAG), BUILD_CACHE_TAG);
  assert.ok(!BUILD_CACHE_TAG.includes("@"));
  assert.ok(!/^sha256:/.test(BUILD_CACHE_TAG));
});

test("cache can be disabled and rejected values fail closed", () => {
  const previous = process.env.DEPLOYKIT_BUILD_CACHE_ENABLED;
  try {
    delete process.env.DEPLOYKIT_BUILD_CACHE_ENABLED;
    assert.equal(getBuildPolicy().cacheEnabled, true);
    process.env.DEPLOYKIT_BUILD_CACHE_ENABLED = "false";
    assert.equal(getBuildPolicy().cacheEnabled, false);
    process.env.DEPLOYKIT_BUILD_CACHE_ENABLED = "0";
    assert.equal(getBuildPolicy().cacheEnabled, false);
    process.env.DEPLOYKIT_BUILD_CACHE_ENABLED = "true";
    assert.equal(getBuildPolicy().cacheEnabled, true);
    process.env.DEPLOYKIT_BUILD_CACHE_ENABLED = "sometimes";
    assert.throws(() => getBuildPolicy(), /DEPLOYKIT_BUILD_CACHE_ENABLED must be a boolean/);
  } finally {
    if (previous === undefined) delete process.env.DEPLOYKIT_BUILD_CACHE_ENABLED;
    else process.env.DEPLOYKIT_BUILD_CACHE_ENABLED = previous;
  }
});
