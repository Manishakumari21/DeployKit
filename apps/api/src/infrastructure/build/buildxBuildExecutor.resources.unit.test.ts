import test from "node:test";
import assert from "node:assert/strict";
import { buildBuildxArgs } from "./buildxBuildExecutor.js";
import { DEFAULT_BUILD_POLICY } from "./buildPolicy.js";

function input(policyOverride = {}) {
  return {
    builder: "deploykit-builder",
    imageReference: "deploykit/project-11111111:d-test",
    commitSha: "a".repeat(40),
    policy: { ...DEFAULT_BUILD_POLICY, ...policyOverride },
  };
}

test("build args enforce memory and cpu-quota via --resource", () => {
  const args = buildBuildxArgs(input({ memoryBytes: 2147483648, cpuLimit: 2 }));
  const resources = args.filter((a, i) => args[i - 1] === "--resource");
  assert.ok(args.includes("--resource"));
  assert.ok(args.includes("memory=2147483648"));
  assert.ok(args.includes("cpu-quota=200000"));
  assert.equal(resources.length, 2);
});

test("cpu-quota scales with cpu limit (period 100000)", () => {
  const args = buildBuildxArgs(input({ cpuLimit: 4 }));
  assert.ok(args.includes("cpu-quota=400000"));
});

test("build args reject zero/negative resource limits", () => {
  for (const override of [{ memoryBytes: 0 }, { cpuLimit: 0 }, { memoryBytes: -1 }, { cpuLimit: -2 }]) {
    try {
      buildBuildxArgs(input(override));
      assert.fail(`expected INVALID_BUILD_POLICY for ${JSON.stringify(override)}`);
    } catch (e) {
      assert.equal((e as { code: string }).code, "INVALID_BUILD_POLICY");
    }
  }
});
