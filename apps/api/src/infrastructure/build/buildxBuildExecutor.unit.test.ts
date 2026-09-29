import test from "node:test";
import assert from "node:assert/strict";

import {
  BuildExecutorError,
  validateImageRepository,
  validateImageTag,
} from "./buildxBuildExecutor.js";

test("accepts a normal image repository", () => {
  assert.equal(
    validateImageRepository(
      "deploykit/my-app"
    ),
    "deploykit/my-app"
  );
});

test("accepts a registry-qualified repository", () => {
  assert.equal(
    validateImageRepository(
      "ghcr.io/manisha/deploykit"
    ),
    "ghcr.io/manisha/deploykit"
  );
});

test("accepts localhost registry with port", () => {
  assert.equal(
    validateImageRepository(
      "localhost:5000/deploykit/app"
    ),
    "localhost:5000/deploykit/app"
  );
});

test("rejects uppercase image repositories", () => {
  assert.throws(
    () =>
      validateImageRepository(
        "DeployKit/app"
      ),
    (error: unknown) =>
      error instanceof BuildExecutorError &&
      error.code === "INVALID_IMAGE_REPOSITORY"
  );
});

test("rejects invalid repository components", () => {
  assert.throws(
    () =>
      validateImageRepository(
        "deploykit/../app"
      ),
    (error: unknown) =>
      error instanceof BuildExecutorError &&
      error.code === "INVALID_IMAGE_REPOSITORY"
  );
});

test("accepts valid image tags", () => {
  assert.equal(
    validateImageTag("abc1234"),
    "abc1234"
  );

  assert.equal(
    validateImageTag("release-2026.09"),
    "release-2026.09"
  );
});

test("rejects invalid image tags", () => {
  for (const tag of [
    "",
    "-latest",
    ".latest",
    "bad tag",
  ]) {
    assert.throws(
      () => validateImageTag(tag),
      (error: unknown) =>
        error instanceof BuildExecutorError &&
        error.code === "INVALID_IMAGE_TAG"
    );
  }
});
