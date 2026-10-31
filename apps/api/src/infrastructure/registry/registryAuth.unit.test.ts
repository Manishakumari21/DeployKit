import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  REGISTRY_PASSWORD_ENV,
  REGISTRY_USERNAME_ENV,
  performRegistryLogin,
  registryLoginArgs,
  registryLoginCaPath,
  resolveRegistryCredentials,
} from "./registryAuth.js";

test("resolveRegistryCredentials returns credentials when both are set", () => {
  const creds = resolveRegistryCredentials({
    [REGISTRY_USERNAME_ENV]: "deploykit",
    [REGISTRY_PASSWORD_ENV]: "s3cret",
  });
  assert.deepEqual(creds, { username: "deploykit", password: "s3cret" });
});

test("resolveRegistryCredentials trims the username but not the password", () => {
  const creds = resolveRegistryCredentials({
    [REGISTRY_USERNAME_ENV]: "  deploykit ",
    [REGISTRY_PASSWORD_ENV]: " has spaces ",
  });
  assert.deepEqual(creds, { username: "deploykit", password: " has spaces " });
});

test("resolveRegistryCredentials is null when either value is missing", () => {
  assert.equal(
    resolveRegistryCredentials({ [REGISTRY_USERNAME_ENV]: "deploykit" }),
    null
  );
  assert.equal(
    resolveRegistryCredentials({ [REGISTRY_PASSWORD_ENV]: "s3cret" }),
    null
  );
  assert.equal(resolveRegistryCredentials({}), null);
});

test("resolveRegistryCredentials is null for blank values", () => {
  assert.equal(
    resolveRegistryCredentials({
      [REGISTRY_USERNAME_ENV]: "   ",
      [REGISTRY_PASSWORD_ENV]: "s3cret",
    }),
    null
  );
  assert.equal(
    resolveRegistryCredentials({
      [REGISTRY_USERNAME_ENV]: "deploykit",
      [REGISTRY_PASSWORD_ENV]: "",
    }),
    null
  );
});

test("registryLoginArgs never places the password in argv", () => {
  const args = registryLoginArgs("registry.example.com:5000", "deploykit");
  assert.deepEqual(args, [
    "login",
    "--username",
    "deploykit",
    "--password-stdin",
    "registry.example.com:5000",
  ]);
  assert.ok(!args.includes("s3cret"));
});

test("registryLoginCaPath resolves and requires an existing CA file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dk-ca-"));
  try {
    const hostDir = path.join(root, "deploykit-registry-tls");
    assert.equal(
      registryLoginCaPath("deploykit-registry-tls:443", root),
      null,
      "no CA file yet -> null"
    );
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(path.join(hostDir, "ca.crt"), "dummy");
    assert.equal(
      registryLoginCaPath("deploykit-registry-tls:443", root),
      path.join(hostDir, "ca.crt")
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("performRegistryLogin pipes the password to stdin and persists DOCKER_CONFIG", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dk-login-"));
  try {
    const fakeBin = path.join(root, "fake-docker");
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
      const { readFileSync } = require("node:fs");
      const argv = process.argv.slice(2);
      if (argv.includes("hunter2")) { process.stderr.write("password leaked into argv"); process.exit(2); }
      if (argv[0] !== "login" || !argv.includes("--password-stdin")) { process.stderr.write("bad argv"); process.exit(3); }
      if (!process.env.DOCKER_CONFIG) { process.stderr.write("DOCKER_CONFIG unset"); process.exit(4); }
      const stdin = readFileSync(0, "utf8");
      if (stdin !== "hunter2") { process.stderr.write("stdin did not carry password"); process.exit(5); }
      process.exit(0);
      `,
      { mode: 0o755 }
    );

    const configDir = path.join(root, "docker-config");
    mkdirSync(configDir, { recursive: true });

    const result = await performRegistryLogin({
      dockerBinary: fakeBin,
      registryHost: "registry.example.com:5000",
      credentials: { username: "deploykit", password: "hunter2" },
      dockerConfigDir: configDir,
    });
    assert.equal(result.code, 0, `login failed: ${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("performRegistryLogin reports a non-zero exit without leaking the password", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dk-login-fail-"));
  try {
    const fakeBin = path.join(root, "fake-docker");
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
      process.stderr.write("Unauthorized: login failed");
      process.exit(1);
      `,
      { mode: 0o755 }
    );

    const result = await performRegistryLogin({
      dockerBinary: fakeBin,
      registryHost: "registry.example.com:5000",
      credentials: { username: "deploykit", password: "hunter2" },
      dockerConfigDir: path.join(root, "docker-config"),
    });
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("Unauthorized"));
    assert.ok(!result.stderr.includes("hunter2"), "password must never be echoed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
