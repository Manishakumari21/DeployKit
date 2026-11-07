import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertBuildContext,
  buildBuildxArgs,
  BuildExecutorError,
} from "./buildxBuildExecutor.js";
import { DEFAULT_BUILD_POLICY } from "./buildPolicy.js";

function baseInput(push?: boolean) {
  return {
    builder: "deploykit-builder",
    imageReference: "localhost:5000/deploykit/project-11111111:d-test",
    commitSha: "a".repeat(40),
    policy: { ...DEFAULT_BUILD_POLICY },
    push,
  };
}

test("local mode uses --load and never --push", () => {
  for (const args of [
    buildBuildxArgs(baseInput()),
    buildBuildxArgs(baseInput(false)),
  ]) {
    assert.ok(args.includes("--load"));
    assert.ok(!args.includes("--push"));
  }
});

test("registry mode uses --push and never --load", () => {
  const args = buildBuildxArgs(baseInput(true));
  assert.ok(args.includes("--push"));
  assert.ok(!args.includes("--load"));
});

test("build args carry metadata file, tag, labels, and resources", () => {
  const args = buildBuildxArgs(baseInput(true));
  const metadataIndex = args.indexOf("--metadata-file");
  assert.notEqual(metadataIndex, -1);
  assert.equal(args[metadataIndex + 1], "<metadata-file>");
  assert.ok(args.includes("localhost:5000/deploykit/project-11111111:d-test"));
  assert.ok(
    args.includes(`org.opencontainers.image.revision=${"a".repeat(40)}`)
  );
  assert.ok(args.includes("io.deploykit.managed=true"));
});

test("build args include --file when dockerfilePath is supplied", () => {
  const input = {
    ...baseInput(false),
    dockerfilePath: "/tmp/deploykit-test/.deploykit.generated.Dockerfile",
  };
  const args = buildBuildxArgs(input);
  const fileIndex = args.indexOf("--file");
  assert.notEqual(fileIndex, -1);
  assert.equal(args[fileIndex + 1], "/tmp/deploykit-test/.deploykit.generated.Dockerfile");
});

test("assertBuildContext: default root Dockerfile validates when dockerfilePath is omitted", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "deploykit-context-test-"));
  try {
    await writeFile(path.join(workspace, "Dockerfile"), "FROM alpine:3.19\n");
    const validated = await assertBuildContext(workspace, 10 * 1024 * 1024);
    assert.equal(validated, path.join(workspace, "Dockerfile"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("assertBuildContext: generated .deploykit.generated.Dockerfile at repository root validates", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "deploykit-context-test-"));
  try {
    const generatedPath = path.join(workspace, ".deploykit.generated.Dockerfile");
    await writeFile(generatedPath, "FROM alpine:3.19\n");
    const validatedAbs = await assertBuildContext(workspace, 10 * 1024 * 1024, generatedPath);
    assert.equal(validatedAbs, generatedPath);

    const validatedRel = await assertBuildContext(workspace, 10 * 1024 * 1024, ".deploykit.generated.Dockerfile");
    assert.equal(validatedRel, generatedPath);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("assertBuildContext: generated Dockerfile inside apps/api validates when apps/api is effective context", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "deploykit-context-test-"));
  try {
    const apiDir = path.join(repo, "apps", "api");
    await mkdir(apiDir, { recursive: true });
    const generatedPath = path.join(apiDir, ".deploykit.generated.Dockerfile");
    await writeFile(generatedPath, "FROM node:20-alpine\n");

    const validated = await assertBuildContext(apiDir, 10 * 1024 * 1024, generatedPath);
    assert.equal(validated, generatedPath);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("assertBuildContext: user-provided apps/api/Dockerfile validates when apps/api is effective context", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "deploykit-context-test-"));
  try {
    const apiDir = path.join(repo, "apps", "api");
    await mkdir(apiDir, { recursive: true });
    const dockerfilePath = path.join(apiDir, "Dockerfile");
    await writeFile(dockerfilePath, "FROM node:20-alpine\n");

    const validated = await assertBuildContext(apiDir, 10 * 1024 * 1024, dockerfilePath);
    assert.equal(validated, dockerfilePath);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("assertBuildContext: missing custom Dockerfile fails with clear error", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "deploykit-context-test-"));
  try {
    await assert.rejects(
      () => assertBuildContext(workspace, 10 * 1024 * 1024, "custom.Dockerfile"),
      (err: unknown) => {
        assert.ok(err instanceof BuildExecutorError);
        assert.equal(err.code, "DOCKERFILE_NOT_FOUND");
        assert.ok(err.message.includes("custom.Dockerfile"));
        return true;
      }
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("assertBuildContext: Dockerfile outside the build context is rejected", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "deploykit-context-test-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "deploykit-outside-test-"));
  try {
    await writeFile(path.join(outside, "Dockerfile"), "FROM alpine:3.19\n");
    await assert.rejects(
      () => assertBuildContext(workspace, 10 * 1024 * 1024, "../outside.Dockerfile"),
      (err: unknown) => {
        assert.ok(err instanceof BuildExecutorError);
        assert.equal(err.code, "INVALID_DOCKERFILE");
        return true;
      }
    );
    await assert.rejects(
      () => assertBuildContext(workspace, 10 * 1024 * 1024, path.join(outside, "Dockerfile")),
      (err: unknown) => {
        assert.ok(err instanceof BuildExecutorError);
        assert.equal(err.code, "INVALID_DOCKERFILE");
        return true;
      }
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("assertBuildContext: a symlink escaping the build context is rejected", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "deploykit-context-test-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "deploykit-outside-test-"));
  try {
    const outsideDockerfile = path.join(outside, "Dockerfile");
    await writeFile(outsideDockerfile, "FROM alpine:3.19\n");

    const symlinkPath = path.join(workspace, "escaped.Dockerfile");
    await symlink(outsideDockerfile, symlinkPath);

    await assert.rejects(
      () => assertBuildContext(workspace, 10 * 1024 * 1024, symlinkPath),
      (err: unknown) => {
        assert.ok(err instanceof BuildExecutorError);
        assert.equal(err.code, "INVALID_DOCKERFILE");
        return true;
      }
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("assertBuildContext: existing build-context size validation still works", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "deploykit-context-test-"));
  try {
    await writeFile(path.join(workspace, "Dockerfile"), "FROM alpine:3.19\n");
    await writeFile(path.join(workspace, "large.bin"), Buffer.alloc(1024 * 1024));
    await assert.rejects(
      () => assertBuildContext(workspace, 1024),
      (err: unknown) => {
        assert.ok(err instanceof BuildExecutorError);
        assert.equal(err.code, "BUILD_CONTEXT_TOO_LARGE");
        return true;
      }
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("buildBuildxArgs: receives expected --file path and context path", () => {
  const customDockerfile = "/tmp/deploykit-workspaces/deployment-123/.deploykit.generated.Dockerfile";

  const inputWithFile = {
    ...baseInput(false),
    dockerfilePath: customDockerfile,
  };
  const argsWithFile = buildBuildxArgs(inputWithFile);
  const fileIndex = argsWithFile.indexOf("--file");
  assert.notEqual(fileIndex, -1);
  assert.equal(argsWithFile[fileIndex + 1], customDockerfile);

  const inputNoFile = baseInput(false);
  const argsNoFile = buildBuildxArgs(inputNoFile);
  assert.equal(argsNoFile.indexOf("--file"), -1);
});
