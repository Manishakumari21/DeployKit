import test from "node:test";
import assert from "node:assert/strict";

import { buildBuildxArgs } from "./buildxBuildExecutor.js";
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
