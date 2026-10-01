import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { DockerImageRegistry } from "./dockerImageRegistry.js";
import { RegistryError } from "./imageRegistry.js";

const TEST_HOST = process.env.DEPLOYKIT_TEST_REGISTRY_HOST ?? "";

const SOURCE_IMAGE = process.env.DEPLOYKIT_TEST_SOURCE_IMAGE ?? "registry:2.8.3";

function docker(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
  });

  return {
    code: result.status ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function requireRegistry(): DockerImageRegistry {
  assert.ok(
    TEST_HOST,
    "DEPLOYKIT_TEST_REGISTRY_HOST must be set (use npm run test:registry)"
  );
  assert.ok(
    !/DEPLOYKIT_TEST_REGISTRY_HOST/.test(TEST_HOST),
    "unexpanded test host"
  );

  return new DockerImageRegistry({
    config: {
      registryHost: TEST_HOST.toLowerCase(),
      namespace: "deploykit-test",
      insecure: true,
    },
  });
}

const SKIP_WITHOUT_REGISTRY =
  TEST_HOST === "" ? "set DEPLOYKIT_TEST_REGISTRY_HOST (use npm run test:registry)" : false;

const REPOSITORY = TEST_HOST
  ? `${TEST_HOST.toLowerCase()}/deploykit-test/regtest-image`
  : "unset/deploykit-test/regtest-image";

test(
  "registry push -> digest -> exists lifecycle",
  { timeout: 300_000, skip: SKIP_WITHOUT_REGISTRY },
  async () => {
    const registry = requireRegistry();

    const pulled = docker(["image", "pull", SOURCE_IMAGE]);
    assert.equal(pulled.code, 0, `docker pull failed: ${pulled.stderr}`);

    const pushed = await registry.push({
      localReference: SOURCE_IMAGE,
      repository: REPOSITORY,
      tag: "regtest-v1",
    });

    assert.equal(pushed.repository, REPOSITORY);
    assert.match(pushed.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(pushed.reference, `${REPOSITORY}@${pushed.digest}`);

    assert.equal(await registry.exists(pushed.reference), true);

    const missing = `${REPOSITORY}@sha256:${"0".repeat(64)}`;
    assert.equal(await registry.exists(missing), false);

    await assert.rejects(
      () => registry.exists(`${REPOSITORY}:mutable-tag`),
      (error: unknown) => error instanceof RegistryError
    );

    const second = await registry.push({
      localReference: SOURCE_IMAGE,
      repository: REPOSITORY,
      tag: "regtest-v1",
    });
    assert.equal(second.digest, pushed.digest);

    docker(["image", "rm", `${REPOSITORY}:regtest-v1`]);
  }
);

test(
  "registry data survives a container restart",
  { timeout: 180_000, skip: SKIP_WITHOUT_REGISTRY },
  async () => {
    const registry = requireRegistry();
    const container = process.env.DEPLOYKIT_TEST_REGISTRY_CONTAINER ?? "";

    assert.ok(
      container,
      "DEPLOYKIT_TEST_REGISTRY_CONTAINER must be set (use npm run test:registry)"
    );

    const pulled = docker(["image", "pull", SOURCE_IMAGE]);
    assert.equal(pulled.code, 0, `docker pull failed: ${pulled.stderr}`);

    const pushed = await registry.push({
      localReference: SOURCE_IMAGE,
      repository: REPOSITORY,
      tag: "regtest-persist",
    });

    const restarted = docker(["container", "restart", container]);
    assert.equal(restarted.code, 0);

    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      const check = spawnSync(
        "curl",
        ["-fs", `http://${TEST_HOST}/v2/`],
        { encoding: "utf8", timeout: 5_000 }
      );
      if (check.status === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(ready, true, "registry did not come back after restart");

    assert.equal(await registry.exists(pushed.reference), true);

    docker(["image", "rm", `${REPOSITORY}:regtest-persist`]);
  }
);

test(
  "unreachable registry is classified as retryable",
  { timeout: 120_000 },
  async () => {
    const registry = new DockerImageRegistry({
      config: {
        registryHost: "127.0.0.1:1",
        namespace: "deploykit-test",
        insecure: true,
      },
      timeoutMs: 10_000,
      pushTimeoutMs: 15_000,
    });

    try {
      await registry.exists(
        `127.0.0.1:1/deploykit-test/regtest-image@sha256:${"f".repeat(64)}`
      );
      assert.fail("expected exists to fail");
    } catch (error) {
      assert.ok(error instanceof RegistryError);
      assert.equal(error.retryable, true);
    }
  }
);
