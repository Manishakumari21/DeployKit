import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BootstrapError,
  buildxRegistryCaConfigPath,
  buildxRegistryCaContainerPath,
  buildxRegistryCaSourcePath,
  desiredBuildkitdToml,
  provisionBuildxRegistryCa,
} from "./workerBootstrap.js";

test("TLS registry config uses the Buildx in-container CA path", () => {
  const config = desiredBuildkitdToml({
    registryHost: "deploykit-registry-tls:443",
    namespace: "deploykit",
    insecure: false,
  });
  assert.ok(config.includes('[registry."deploykit-registry-tls:443"]'));
  assert.ok(config.includes('ca = ["/certs/deploykit-registry-tls/ca.crt"]'));
});

test("Buildx registry CA paths include the full host and port", () => {
  assert.equal(
    buildxRegistryCaSourcePath("deploykit-registry-tls:443"),
    "/certs/deploykit-registry-tls/ca.crt"
  );
  assert.equal(
    buildxRegistryCaContainerPath("deploykit-registry-tls:443"),
    "/etc/buildkit/certs/deploykit-registry-tls_443/ca.crt"
  );
  assert.ok(buildxRegistryCaConfigPath("/tmp/buildx", "deploykit-registry-tls:443").endsWith("certs/deploykit-registry-tls:443/ca.crt"));
});

test("provisionBuildxRegistryCa copies a valid CA certificate", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "buildx-config-"));
  const sourceDir = await mkdtemp(join(tmpdir(), "cert-source-"));
  const sourcePath = join(sourceDir, "ca.crt");
  const caPem = "-----BEGIN CERTIFICATE-----\nTEST-CA\n-----END CERTIFICATE-----\n";
  try {
    await writeFile(sourcePath, caPem, "utf8");
    const provisioned = await provisionBuildxRegistryCa(configDir, "deploykit-registry-tls:443", sourcePath);
    assert.equal(provisioned.containerCaPath, "/etc/buildkit/certs/deploykit-registry-tls_443/ca.crt");
    assert.equal(provisioned.caSha256.length, 64);
    const copied = await import("node:fs/promises").then(({ readFile }) => readFile(buildxRegistryCaConfigPath(configDir, "deploykit-registry-tls:443"), "utf8"));
    assert.equal(copied, caPem);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

test("provisionBuildxRegistryCa fails closed when the CA source is missing", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "buildx-config-"));
  try {
    await assert.rejects(
      () => provisionBuildxRegistryCa(configDir, "deploykit-registry-tls:443", join(configDir, "missing-ca.crt")),
      (error: unknown) => error instanceof BootstrapError && error.code === "REGISTRY_CA_UNAVAILABLE"
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("provisionBuildxRegistryCa fails closed for malformed CA content", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "buildx-config-"));
  const sourceDir = await mkdtemp(join(tmpdir(), "cert-source-"));
  const sourcePath = join(sourceDir, "bad-ca.crt");
  try {
    await writeFile(sourcePath, "not a certificate", "utf8");
    await assert.rejects(
      () => provisionBuildxRegistryCa(configDir, "deploykit-registry-tls:443", sourcePath),
      (error: unknown) => error instanceof BootstrapError && error.code === "REGISTRY_CA_INVALID"
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});
