import test from "node:test";
import assert from "node:assert/strict";

import { DockerRuntimeManager } from "../infrastructure/runtime/dockerRuntimeManager.js";
import { shouldPullImage, assertRegistryDiskHasSpace } from "./deploymentPipeline.js";

const CONFIG = {
  registryHost: "localhost:5000",
  namespace: "deploykit",
  insecure: true,
};

test("shouldPullImage only pulls registry-managed repositories", () => {
  assert.equal(
    shouldPullImage(
      "localhost:5000/deploykit/project-11111111",
      CONFIG
    ),
    true
  );
  assert.equal(
    shouldPullImage("deploykit/project-11111111", CONFIG),
    false
  );
  assert.equal(
    shouldPullImage("localhost:5000/deploykit/project-11111111", null),
    false
  );
  assert.equal(
    shouldPullImage(
      "other:5000/deploykit/project-11111111",
      CONFIG
    ),
    false
  );
});

test("runtime pull rejects mutable tags without invoking Docker", async () => {
  const manager = new DockerRuntimeManager({
    dockerBinary: "definitely-not-a-docker-binary-xyz",
  });

  await assert.rejects(() =>
    manager.pull("localhost:5000/deploykit/project-x:latest")
  );
});

test("a critically full registry blocks the build (fail closed)", async () => {
  await assert.rejects(
    () =>
      assertRegistryDiskHasSpace(
        async () => ({ usedPercent: 96, availableKB: 1_000_000 }),
        { softPercent: 85, hardPercent: 95 }
      ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "REGISTRY_DISK_FULL");
      assert.equal((error as { retryable?: boolean }).retryable, false);
      return true;
    }
  );
});

test("the hard threshold is inclusive but soft/ok do not block", async () => {
  // Exactly at the hard threshold must block (inclusive).
  await assert.rejects(
    () =>
      assertRegistryDiskHasSpace(async () => ({ usedPercent: 95, availableKB: 1 }), {
        softPercent: 85,
        hardPercent: 95,
      }),
    (error: unknown) => (error as { code?: string }).code === "REGISTRY_DISK_FULL"
  );
  // Soft pressure and ok do not block.
  await assert.doesNotReject(() =>
    assertRegistryDiskHasSpace(async () => ({ usedPercent: 85, availableKB: 1 }), {
      softPercent: 85,
      hardPercent: 95,
    })
  );
  await assert.doesNotReject(() =>
    assertRegistryDiskHasSpace(async () => ({ usedPercent: 10, availableKB: 1 }), {
      softPercent: 85,
      hardPercent: 95,
    })
  );
});

test("an unknown or failing disk reading never blocks a deploy (fail open)", async () => {
  await assert.doesNotReject(() =>
    assertRegistryDiskHasSpace(async () => null, { softPercent: 85, hardPercent: 95 })
  );
  await assert.doesNotReject(() =>
    assertRegistryDiskHasSpace(async () => {
      throw new Error("docker unreachable");
    }, { softPercent: 85, hardPercent: 95 })
  );
});
