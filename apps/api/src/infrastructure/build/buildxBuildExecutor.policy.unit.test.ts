import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BuildxBuildExecutor,
  BuildExecutorError,
} from "./buildxBuildExecutor.js";

function policy(overrides = {}) {
  return {
    timeoutMs: 30_000,
    memoryBytes: 512 * 1024 * 1024,
    cpuLimit: 1,
    networkEnabled: true,
    maxBuildContextBytes: 10 * 1024 * 1024,
    ...overrides,
  };
}

test("rejects invalid commit SHA without invoking docker", async () => {
  const executor = new BuildxBuildExecutor({
    dockerBinary: "definitely-not-a-binary",
  });
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "deploykit-build-unit-")
  );
  try {
    await writeFile(
      path.join(workspace, "Dockerfile"),
      "FROM alpine:3.22\n"
    );
    await assert.rejects(
      executor.build({
        workspace,
        imageRepository: "deploykit/app",
        imageTag: "d-abc-1234567",
        commitSha: "not-a-sha",
        policy: policy(),
      }),
      (error: unknown) =>
        error instanceof BuildExecutorError &&
        error.code === "INVALID_COMMIT_SHA"
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rejects oversized build context", async () => {
  const executor = new BuildxBuildExecutor({
    dockerBinary: "definitely-not-a-binary",
  });
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "deploykit-build-unit-")
  );
  try {
    await writeFile(
      path.join(workspace, "Dockerfile"),
      "FROM alpine:3.22\n"
    );
    await writeFile(
      path.join(workspace, "big.bin"),
      Buffer.alloc(2048, "x")
    );
    await assert.rejects(
      executor.build({
        workspace,
        imageRepository: "deploykit/app",
        imageTag: "d-abc-1234567",
        commitSha: "0".repeat(40),
        policy: policy({ maxBuildContextBytes: 1024 }),
      }),
      (error: unknown) =>
        error instanceof BuildExecutorError &&
        error.code === "BUILD_CONTEXT_TOO_LARGE"
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rejects missing Dockerfile", async () => {
  const executor = new BuildxBuildExecutor({
    dockerBinary: "definitely-not-a-binary",
  });
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "deploykit-build-unit-")
  );
  try {
    await assert.rejects(
      executor.build({
        workspace,
        imageRepository: "deploykit/app",
        imageTag: "d-abc-1234567",
        commitSha: "0".repeat(40),
        policy: policy(),
      }),
      (error: unknown) =>
        error instanceof BuildExecutorError &&
        error.code === "DOCKERFILE_NOT_FOUND"
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wraps docker execution failure without leaking temp dirs", async () => {
  const executor = new BuildxBuildExecutor({
    dockerBinary: "definitely-not-a-binary",
  });
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "deploykit-build-unit-")
  );
  try {
    await writeFile(
      path.join(workspace, "Dockerfile"),
      "FROM alpine:3.22\n"
    );
    await assert.rejects(
      executor.build({
        workspace,
        imageRepository: "deploykit/app",
        imageTag: "d-abc-1234567",
        commitSha: "0".repeat(40),
        policy: policy(),
      }),
      (error: unknown) =>
        error instanceof BuildExecutorError &&
        error.code === "BUILD_EXECUTION_FAILED"
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
