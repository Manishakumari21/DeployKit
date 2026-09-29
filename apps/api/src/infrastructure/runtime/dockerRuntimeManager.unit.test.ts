import test from "node:test";
import assert from "node:assert/strict";

import { DockerRuntimeManager } from "./dockerRuntimeManager.js";

test("rejects mutable tags without digest", async () => {
  const manager = new DockerRuntimeManager({
    dockerBinary: "definitely-not-a-binary",
  });
  await assert.rejects(
    manager.create({
      containerName: "dk-test-1",
      imageReference: "deploykit/app:latest",
      networkName: "deploykit-runtime",
      containerPort: 3000,
      environment: {},
      healthPath: "/",
      memoryBytes: 512 * 1024 * 1024,
      cpuLimit: 1,
      pidsLimit: 256,
    }),
    /immutable digest/
  );
});

test("rejects invalid env names and control characters", async () => {
  const manager = new DockerRuntimeManager({
    dockerBinary: "definitely-not-a-binary",
  });
  const digest = `deploykit/app@sha256:${"a".repeat(64)}`;
  await assert.rejects(
    manager.create({
      containerName: "dk-test-1",
      imageReference: digest,
      networkName: "deploykit-runtime",
      containerPort: 3000,
      environment: { "BAD-NAME": "x" },
      healthPath: "/",
      memoryBytes: 512 * 1024 * 1024,
      cpuLimit: 1,
      pidsLimit: 256,
    }),
    /Invalid environment variable name/
  );
  await assert.rejects(
    manager.create({
      containerName: "dk-test-1",
      imageReference: digest,
      networkName: "deploykit-runtime",
      containerPort: 3000,
      environment: { GOOD: "a\nb" },
      healthPath: "/",
      memoryBytes: 512 * 1024 * 1024,
      cpuLimit: 1,
      pidsLimit: 256,
    }),
    /invalid characters/i
  );
});

test("rejects invalid container and health paths", async () => {
  const manager = new DockerRuntimeManager({
    dockerBinary: "definitely-not-a-binary",
  });
  const digest = `deploykit/app@sha256:${"a".repeat(64)}`;
  await assert.rejects(
    manager.create({
      containerName: "Bad Name!",
      imageReference: digest,
      networkName: "deploykit-runtime",
      containerPort: 3000,
      environment: {},
      healthPath: "/",
      memoryBytes: 512 * 1024 * 1024,
      cpuLimit: 1,
      pidsLimit: 256,
    }),
    /Invalid runtime container name/
  );
  await assert.rejects(
    manager.create({
      containerName: "dk-test-1",
      imageReference: digest,
      networkName: "deploykit-runtime",
      containerPort: 3000,
      environment: {},
      healthPath: "no-slash",
      memoryBytes: 512 * 1024 * 1024,
      cpuLimit: 1,
      pidsLimit: 256,
    }),
    /Health path must start/
  );
});
