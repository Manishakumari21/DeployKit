import test from "node:test";
import assert from "node:assert/strict";

import {
  DockerImageRegistry,
  classifyDockerFailure,
  isAuthMessage,
  isNetworkMessage,
  isNotFoundMessage,
  parseImagetoolsDigest,
  validateDigestReference,
  validateLocalReference,
} from "./dockerImageRegistry.js";
import { RegistryError } from "./imageRegistry.js";

const TEST_CONFIG = {
  registryHost: "localhost:5000",
  namespace: "deploykit",
  insecure: true,
};

const DIGEST = `sha256:${"a".repeat(64)}`;
const REPOSITORY = "localhost:5000/deploykit/project-11111111";

test("local reference validation rejects shell metacharacters", () => {
  assert.equal(validateLocalReference("myimage:test-tag"), "myimage:test-tag");
  assert.throws(() => validateLocalReference(""));
  assert.throws(() => validateLocalReference("-evil"));
  assert.throws(() => validateLocalReference("img; rm -rf /"));
  assert.throws(() => validateLocalReference("img | cat"));
  assert.throws(() => validateLocalReference("img$(id)"));
  assert.throws(() => validateLocalReference("img `id`"));
  assert.throws(() => validateLocalReference("http://host/img"));
});

test("digest reference validation requires immutable form", () => {
  const parsed = validateDigestReference(`${REPOSITORY}@${DIGEST}`);
  assert.equal(parsed.repository, REPOSITORY);
  assert.equal(parsed.digest, DIGEST);
  assert.throws(() => validateDigestReference(`${REPOSITORY}:sometag`));
  assert.throws(() => validateDigestReference(`${REPOSITORY}@sha256:short`));
});

test("parseImagetoolsDigest extracts the stored manifest digest", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(
    parseImagetoolsDigest(
      JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json", digest, size: 1915 })
    ),
    digest
  );
  assert.equal(parseImagetoolsDigest("not-json"), null);
  assert.equal(parseImagetoolsDigest(JSON.stringify({ size: 1 })), null);
  assert.equal(
    parseImagetoolsDigest(JSON.stringify({ digest: "sha256:short" })),
    null
  );
});

test("failure message classifiers", () => {
  assert.equal(isNotFoundMessage("Error: manifest unknown: not found"), true);
  assert.equal(isNotFoundMessage("no such manifest"), true);
  assert.equal(isNotFoundMessage("connection refused"), false);
  assert.equal(isAuthMessage("unauthorized: authentication required"), true);
  assert.equal(isAuthMessage("access denied"), true);
  assert.equal(isAuthMessage("manifest unknown"), false);
  assert.equal(isNetworkMessage("connection refused"), true);
  assert.equal(isNetworkMessage("dial tcp: no such host"), true);
  assert.equal(isNetworkMessage("unauthorized"), false);
});

test("classifyDockerFailure maps to typed codes", () => {
  assert.deepEqual(classifyDockerFailure("", true), {
    code: "TIMEOUT",
    retryable: true,
  });
  assert.deepEqual(classifyDockerFailure("unauthorized", false), {
    code: "AUTH_FAILED",
    retryable: false,
  });
  assert.deepEqual(classifyDockerFailure("connection refused", false), {
    code: "REGISTRY_UNAVAILABLE",
    retryable: true,
  });
  assert.deepEqual(classifyDockerFailure("something weird", false), {
    code: "PUSH_FAILED",
    retryable: false,
  });
});

test("push rejects invalid input before invoking Docker", async () => {
  const registry = new DockerImageRegistry({
    config: TEST_CONFIG,
    dockerBinary: "definitely-not-a-docker-binary-xyz",
  });

  await assert.rejects(
    () =>
      registry.push({
        localReference: "img; evil",
        repository: REPOSITORY,
        tag: "d-aaaaaaaa-aaaaaaa",
      }),
    (error: unknown) =>
      error instanceof RegistryError &&
      error.code === "INVALID_REFERENCE" &&
      error.retryable === false
  );

  await assert.rejects(
    () =>
      registry.push({
        localReference: "myimage:test",
        repository: "other-host:5000/deploykit/project-x",
        tag: "d-aaaaaaaa-aaaaaaa",
      }),
    (error: unknown) =>
      error instanceof RegistryError &&
      error.code === "INVALID_REFERENCE"
  );

  await assert.rejects(
    () =>
      registry.push({
        localReference: "myimage:test",
        repository: REPOSITORY,
        tag: "bad tag!",
      }),
    (error: unknown) =>
      error instanceof RegistryError &&
      error.code === "INVALID_REFERENCE"
  );
});

test("push classifies an unreachable Docker binary as retryable", async () => {
  const registry = new DockerImageRegistry({
    config: TEST_CONFIG,
    dockerBinary: "definitely-not-a-docker-binary-xyz",
    timeoutMs: 5_000,
  });

  await assert.rejects(
    () =>
      registry.push({
        localReference: "myimage:test",
        repository: REPOSITORY,
        tag: "d-aaaaaaaa-aaaaaaa",
      }),
    (error: unknown) =>
      error instanceof RegistryError &&
      error.code === "REGISTRY_UNAVAILABLE" &&
      error.retryable === true
  );
});

test("exists rejects mutable tags before invoking Docker", async () => {
  const registry = new DockerImageRegistry({
    config: TEST_CONFIG,
    dockerBinary: "definitely-not-a-docker-binary-xyz",
  });

  await assert.rejects(
    () => registry.exists(`${REPOSITORY}:latest`),
    (error: unknown) =>
      error instanceof RegistryError && error.code === "INVALID_REFERENCE"
  );
});

test("registry errors never embed Docker output in the message", async () => {
  const registry = new DockerImageRegistry({
    config: TEST_CONFIG,
    dockerBinary: "definitely-not-a-docker-binary-xyz",
  });

  try {
    await registry.push({
      localReference: "myimage:test",
      repository: REPOSITORY,
      tag: "d-aaaaaaaa-aaaaaaa",
    });
    assert.fail("expected push to fail");
  } catch (error) {
    assert.ok(error instanceof RegistryError);
    assert.ok(!error.message.includes("password"));
    assert.ok(error.message.length < 200);
  }
});
