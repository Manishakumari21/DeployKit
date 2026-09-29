import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BUILD_POLICY,
  getBuildPolicy,
} from "./buildPolicy.js";

const ENV_KEYS = [
  "DEPLOYKIT_BUILD_TIMEOUT_MS",
  "DEPLOYKIT_BUILD_MEMORY_BYTES",
  "DEPLOYKIT_BUILD_CPU_LIMIT",
  "DEPLOYKIT_BUILD_PIDS_LIMIT",
  "DEPLOYKIT_MAX_BUILD_CONTEXT_BYTES",
] as const;

function withCleanBuildEnvironment(
  fn: () => void
): void {
  const previous = new Map<
    string,
    string | undefined
  >();

  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("uses default build policy", () => {
  withCleanBuildEnvironment(() => {
    assert.deepEqual(
      getBuildPolicy(),
      DEFAULT_BUILD_POLICY
    );
  });
});

test("accepts valid overrides", () => {
  withCleanBuildEnvironment(() => {
    process.env.DEPLOYKIT_BUILD_TIMEOUT_MS = "60000";
    process.env.DEPLOYKIT_BUILD_MEMORY_BYTES = "1073741824";
    process.env.DEPLOYKIT_BUILD_CPU_LIMIT = "4";
    process.env.DEPLOYKIT_BUILD_PIDS_LIMIT = "256";
    process.env.DEPLOYKIT_MAX_BUILD_CONTEXT_BYTES = "536870912";

    const policy = getBuildPolicy();

    assert.equal(policy.timeoutMs, 60000);
    assert.equal(policy.memoryBytes, 1073741824);
    assert.equal(policy.cpuLimit, 4);
    assert.equal(policy.pidsLimit, 256);
    assert.equal(policy.maxBuildContextBytes, 536870912);
  });
});

test("rejects zero values", () => {
  withCleanBuildEnvironment(() => {
    process.env.DEPLOYKIT_BUILD_CPU_LIMIT = "0";

    assert.throws(
      () => getBuildPolicy(),
      /DEPLOYKIT_BUILD_CPU_LIMIT must be a positive safe integer/
    );
  });
});

test("rejects negative values", () => {
  withCleanBuildEnvironment(() => {
    process.env.DEPLOYKIT_BUILD_TIMEOUT_MS = "-1";

    assert.throws(
      () => getBuildPolicy(),
      /DEPLOYKIT_BUILD_TIMEOUT_MS must be a positive safe integer/
    );
  });
});

test("rejects non-numeric values", () => {
  withCleanBuildEnvironment(() => {
    process.env.DEPLOYKIT_BUILD_MEMORY_BYTES = "abc";

    assert.throws(
      () => getBuildPolicy(),
      /DEPLOYKIT_BUILD_MEMORY_BYTES must be a positive safe integer/
    );
  });
});
