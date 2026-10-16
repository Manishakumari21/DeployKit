import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_BUILDKITD_TOML,
  BootstrapError,
  buildkitdMarkerPath,
  buildkitdTomlPath,
  desiredBuildkitdToml,
  parseBuilderNetworks,
  resolveBuilderEnsureAction,
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

test("builder ensure creates when no builder and no container exist", () => {
  assert.equal(
    resolveBuilderEnsureAction({
      builderRegistered: false,
      builderContainerExists: false,
      markerSha: null,
      desiredSha: "abc123",
    }),
    "create"
  );
});

test("builder ensure reuses a registered builder whose marker matches", () => {
  assert.equal(
    resolveBuilderEnsureAction({
      builderRegistered: true,
      builderContainerExists: true,
      markerSha: "abc123",
      desiredSha: "abc123",
    }),
    "reuse"
  );
});

test("builder ensure recreates a registered builder whose marker drifted", () => {
  assert.equal(
    resolveBuilderEnsureAction({
      builderRegistered: true,
      builderContainerExists: true,
      markerSha: "stale-sha",
      desiredSha: "abc123",
    }),
    "recreate"
  );
});

test("builder ensure refuses to act when a container exists but the builder is unregistered", () => {
  assert.equal(
    resolveBuilderEnsureAction({
      builderRegistered: false,
      builderContainerExists: true,
      markerSha: null,
      desiredSha: "abc123",
    }),
    "conflict",
    "an unmanaged existing container must never fall through to create"
  );
});

test("an unmanaged builder container is reported instead of created or removed", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const src = await readFile(join(process.cwd(), "src/workers/workerBootstrap.ts"), "utf8");

  assert.ok(src.includes("BUILDER_CONTAINER_UNMANAGED"));

  const actionBranch = src.indexOf('if (action === "conflict"');
  const createBranch = src.indexOf('if (action === "create")');
  const recreateBranch = src.indexOf('} else if (action === "recreate")');
  assert.ok(actionBranch > 0, "conflict branch must exist");
  assert.ok(createBranch > actionBranch, "conflict must be checked before create");
  assert.ok(recreateBranch > createBranch, "recreate must follow create");
});

test("the conflict error names the builder and container without leaking configuration values", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const src = await readFile(join(process.cwd(), "src/workers/workerBootstrap.ts"), "utf8");

  const start = src.indexOf('"BUILDER_CONTAINER_UNMANAGED"');
  const segment = src.slice(start, start + 700);

  assert.ok(segment.includes("Refusing to create or replace"));
  assert.ok(segment.includes("DEPLOYKIT_BUILDER_NAME"));
  assert.ok(!/process\.env\.[A-Z_]*(TOKEN|SECRET|PASSWORD|CREDENTIAL)/.test(segment));
});

test("builder networks parse a valid list in order", () => {
  assert.deepEqual(parseBuilderNetworks("deploykit-default"), ["deploykit-default"]);
  assert.deepEqual(
    parseBuilderNetworks("deploykit-default, deploykit-runtime ,bridge"),
    ["deploykit-default", "deploykit-runtime", "bridge"]
  );
});

test("builder networks normalise case deterministically", () => {
  assert.deepEqual(parseBuilderNetworks("DeployKit-Default"), ["deploykit-default"]);
});

test("builder networks reject an empty configured value", () => {
  assert.throws(
    () => parseBuilderNetworks(""),
    (e: unknown) => e instanceof BootstrapError && e.code === "BUILDER_NETWORK_CONFIG_INVALID"
  );
  assert.throws(
    () => parseBuilderNetworks("   "),
    (e: unknown) => e instanceof BootstrapError && e.code === "BUILDER_NETWORK_CONFIG_INVALID"
  );
});

test("builder networks reject empty entries", () => {
  for (const raw of ["a,,b", ",a", "a,", "a , ,b"]) {
    assert.throws(
      () => parseBuilderNetworks(raw),
      (e: unknown) => e instanceof BootstrapError && e.code === "BUILDER_NETWORK_CONFIG_INVALID",
      `expected rejection for ${JSON.stringify(raw)}`
    );
  }
});

test("builder networks reject malformed names", () => {
  for (const raw of ["has space", "-leading-dash", "UPPER/slash", "under_score-ok!".slice(0, 0) + "bad!", "a".repeat(64)]) {
    assert.throws(
      () => parseBuilderNetworks(raw),
      (e: unknown) => e instanceof BootstrapError && e.code === "BUILDER_NETWORK_CONFIG_INVALID",
      `expected rejection for ${JSON.stringify(raw)}`
    );
  }
});

test("builder networks reject duplicates rather than silently collapsing them", () => {
  assert.throws(
    () => parseBuilderNetworks("deploykit-default,deploykit-default"),
    (e: unknown) => e instanceof BootstrapError && e.code === "BUILDER_NETWORK_CONFIG_INVALID"
  );
  assert.throws(
    () => parseBuilderNetworks("bridge,deploykit-runtime,bridge"),
    (e: unknown) => e instanceof BootstrapError && e.code === "BUILDER_NETWORK_CONFIG_INVALID"
  );
});

test("builder network errors never echo the raw environment value", () => {
  const secretish = "Secret Network Value/With-Slashes";
  try {
    parseBuilderNetworks(secretish);
    assert.fail("expected rejection");
  } catch (e) {
    assert.ok(e instanceof BootstrapError);
    assert.ok(
      !e.message.includes(secretish),
      "the raw configured value must not appear in the error message"
    );
  }
});

test("explicit builder networks are not consulted when discovery succeeds", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const src = await readFile(join(process.cwd(), "src/workers/workerBootstrap.ts"), "utf8");

  const discoveredIndex = src.indexOf("if (discovered) {");
  const explicitIndex = src.indexOf("const explicit = explicitBuilderNetworks()");
  assert.ok(discoveredIndex > 0 && explicitIndex > discoveredIndex,
    "explicit configuration must only be read after container discovery fails");

  // Validation must never attach a network.
  const validateStart = src.indexOf("async function assertDockerNetworksExist");
  const validateEnd = src.indexOf("async function workerContainerNetworks");
  const segment = src.slice(validateStart, validateEnd);
  assert.ok(segment.includes('"network", "inspect"'), "existence check must be a read-only inspect");
  assert.ok(!segment.includes("network connect"), "validation must not attach networks");
});

test("the Part A builder conflict guard survives the network change", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const src = await readFile(join(process.cwd(), "src/workers/workerBootstrap.ts"), "utf8");

  assert.ok(src.includes("BUILDER_CONTAINER_UNMANAGED"));
  assert.ok(src.includes("resolveBuilderEnsureAction"));
  assert.ok(
    src.indexOf("BUILDER_CONTAINER_UNMANAGED") < src.indexOf('if (action === "create")'),
    "conflict guard must still precede the create path"
  );
});
