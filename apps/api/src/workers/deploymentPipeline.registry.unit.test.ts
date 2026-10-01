import test from "node:test";
import assert from "node:assert/strict";

import { DockerRuntimeManager } from "../infrastructure/runtime/dockerRuntimeManager.js";
import { shouldPullImage } from "./deploymentPipeline.js";

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
