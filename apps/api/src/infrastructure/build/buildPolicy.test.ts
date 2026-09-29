import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BUILD_POLICY,
  getBuildPolicy,
} from "./buildPolicy.js";

function withEnv(
  values: Record<string, string | undefined>,
  fn: () => void
) {
  const previous = new Map<string, string | undefined>();

  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    const value = values[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
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

test("returns the default build policy", () => {
  withEnv(
    {
      DEPLOYKIT_BUILD_TIMEOUT_MS: undefined,
      DEPLOYKIT_BUILD_MEMORY_BYTES: undefined,
      DEPLOYKIT_BUILD_CPU_LIMIT: undefined,
      DEPLOYKIT_BUILD_PIDS_LIMIT: undefined,
      DEPLOYKIT_MAX_BUILD_CONTEXT_BYTES: undefined,
    },
    () => {
      assert.deepEqual(
        getBuildPolicy(),
        DEFAULT_BUILD_POLICY
      );
    }
  );
});

test("accepts valid policy overrides", () => {
  withEnv(
    {
      DEPLOYKIT_BUILD_TIMEOUT_MS: "60000",
      DEPLOYKIT_BUILD_MEMORY_BYTES: "1073741824",
      DEPLOYKIT_BUILD_CPU_LIMIT: "4",
      DEPLOYKIT_BUILD_PIDS_LIMIT: "256",
      DEPLOYKIT_MAX_BUILD_CONTEXT_BYTES: "536870912",
    },
    () => {
      const policy = getBuildPolicy();

      assert.equal(policy.timeoutMs, 60000);
      assert.equal(policy.memoryBytes, 1073741824);
      assert.equal(policy.cpuLimit, 4);
      assert.equal(policy.pidsLimit, 256);
      assert.equal(policy.maxBuildContextBytes, 536870912);
    }
  );
});

test("rejects zero values", () => {
  withEnv(
    { DEPLOYKIT_BUILD_CPU_LIMIT: "0" },
    () => {
      assert.throws(
        () => getBuildPolicy(),
        /DEPLOYKIT_BUILD_CPU_LIMIT must be a positive safe integer/
      );
    }
  );
});

test("rejects negative values", () => {
  withEnv(
    { DEPLOYKIT_BUILD_TIMEOUT_MS: "-1" },
    () => {
      assert.throws(
        () => getBuildPolicy(),
        /DEPLOYKIT_BUILD_TIMEOUT_MS must be a positive safe integer/
      );
    }
  );
});

test("rejects non-numeric values", () => {
  withEnv(
    { DEPLOYKIT_BUILD_MEMORY_BYTES: "abc" },
    () => {
      assert.throws(
        () => getBuildPolicy(),
        /DEPLOYKIT_BUILD_MEMORY_BYTES must be a positive safe integer/
      );
    }
  );
});
