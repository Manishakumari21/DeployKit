import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_BUILDKITD_TOML,
  BootstrapError,
  buildkitdMarkerPath,
  buildkitdTomlPath,
  desiredBuildkitdToml,
  sha256Hex,
} from "./workerBootstrap.js";

test("bootstrap fails closed when Docker CLI is missing", async () => {
  process.env.DEPLOYKIT_DOCKER_BINARY = "definitely-not-a-docker-binary-xyz";
  try {
    const { bootstrapWorker } = await import("./workerBootstrap.js");
    await assert.rejects(() => bootstrapWorker(), (e: unknown) => {
      assert.ok(e instanceof BootstrapError);
      assert.match((e as BootstrapError).code, /DOCKER_CLI_MISSING|DOCKER_DAEMON_UNREACHABLE|BUILDX_UNAVAILABLE|BUILDER_/);
      return true;
    });
  } finally {
    delete process.env.DEPLOYKIT_DOCKER_BINARY;
  }
});

test("bootstrap rejects invalid builder names fail-closed", async () => {
  process.env.DEPLOYKIT_BUILDER_NAME = "bad name!";
  try {
    const { bootstrapWorker } = await import("./workerBootstrap.js");
    await assert.rejects(() => bootstrapWorker(), (e: unknown) => {
      assert.ok(e instanceof BootstrapError);
      assert.equal((e as BootstrapError).code, "INVALID_BUILDER_NAME");
      return true;
    });
  } finally {
    delete process.env.DEPLOYKIT_BUILDER_NAME;
  }
});

test("bootstrap never uses shell pipelines", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const src = await readFile(join(process.cwd(), "src/workers/workerBootstrap.ts"), "utf8");
  assert.ok(!src.includes("sh -c"));
  assert.ok(!src.includes("shell: true"));
  assert.ok(src.includes("deploykit-builder"));
  assert.ok(src.includes("BUILDX_CONFIG"));
});

test("embedded buildkitd base is the canonical config used by bootstrap", () => {
  // BASE_BUILDKITD_TOML is the single source of truth written to the
  // deterministic builder (see desiredBuildkitdToml/bootstrapWorker).
  // The repo mirror ops/buildkit/buildkitd.toml is intentionally not copied
  // into the API image (/app), so this test pins the canonical shape
  // directly instead of reading a host absolute path that cannot exist in
  // the container. It fails closed if the base drifts.
  assert.equal(desiredBuildkitdToml(null), BASE_BUILDKITD_TOML);
  for (const required of [
    "debug = false",
    "insecure-entitlements = []",
    '[log]',
    'level = "info"',
    'format = "json"',
    "[worker.oci]",
    "max-parallelism = 2",
  ]) {
    assert.ok(
      BASE_BUILDKITD_TOML.includes(required),
      `base buildkitd config must contain: ${required}`
    );
  }
  assert.ok(
    !BASE_BUILDKITD_TOML.includes("[registry."),
    "base config must not contain per-registry stanzas"
  );
  assert.ok(BASE_BUILDKITD_TOML.endsWith("\n"));
});

test("desired buildkitd config adds http stanza only for insecure registries", () => {
  const base = desiredBuildkitdToml(null);
  assert.equal(base, BASE_BUILDKITD_TOML);
  assert.ok(!base.includes("[registry."));

  const insecure = desiredBuildkitdToml({ registryHost: "deploykit-registry:5000", namespace: "deploykit", insecure: true });
  assert.ok(insecure.startsWith(BASE_BUILDKITD_TOML));
  assert.ok(insecure.includes('[registry."deploykit-registry:5000"]'));
  assert.ok(insecure.includes("http = true"));

  const secure = desiredBuildkitdToml({ registryHost: "registry.example.com", namespace: "deploykit", insecure: false });
  assert.equal(secure, BASE_BUILDKITD_TOML);
});

test("buildkitd marker is a stable sha of the desired config", () => {
  const a = desiredBuildkitdToml({ registryHost: "deploykit-registry:5000", namespace: "deploykit", insecure: true });
  const b = desiredBuildkitdToml({ registryHost: "deploykit-registry:5000", namespace: "deploykit", insecure: true });
  assert.equal(sha256Hex(a), sha256Hex(b));
  assert.notEqual(sha256Hex(a), sha256Hex(BASE_BUILDKITD_TOML));
  assert.ok(buildkitdTomlPath("/cfg").endsWith("buildkitd.toml"));
  assert.ok(buildkitdMarkerPath("/cfg").endsWith(".sha256"));
});

test("bootstrap fails closed on invalid registry configuration", async () => {
  process.env.DEPLOYKIT_REGISTRY_HOST = "https://not-a-registry-host";
  process.env.DEPLOYKIT_REGISTRY_NAMESPACE = "deploykit";
  try {
    const { bootstrapWorker } = await import("./workerBootstrap.js");
    await assert.rejects(() => bootstrapWorker(), (e: unknown) => {
      assert.ok(e instanceof BootstrapError);
      assert.equal((e as BootstrapError).code, "REGISTRY_CONFIG_INVALID");
      return true;
    });
  } finally {
    delete process.env.DEPLOYKIT_REGISTRY_HOST;
    delete process.env.DEPLOYKIT_REGISTRY_NAMESPACE;
  }
});
