import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { performRegistryLogin } from "./registryAuth.js";
import { DockerImageRegistry } from "./dockerImageRegistry.js";

const SOURCE_IMAGE = process.env.DEPLOYKIT_TEST_SOURCE_IMAGE ?? "registry:2.8.3";

function docker(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", shell: false, timeout: 120_000 });
  return {
    code: result.status ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function dockerAvailable(): boolean {
  return docker(["version"]).code === 0;
}

const SKIP = dockerAvailable() ? false : "docker is not available";

// Spins up an ephemeral htpasswd-authenticated registry on an ephemeral port and
// returns everything the tests need to exercise the credential flow end to end.
async function startAuthRegistry(): Promise<{
  host: string;
  container: string;
  username: string;
  password: string;
  configDir: string;
  cleanup: () => void;
}> {
  const port = 5200 + Math.floor(Math.random() * 300);
  const host = `127.0.0.1:${port}`;
  const container = `dk-auth-it-${port}`;
  const username = "deploykit";
  const password = randomBytes(16).toString("hex");

  const workDir = mkdtempSync(path.join(tmpdir(), "dk-auth-it-"));
  const authDir = path.join(workDir, "auth");
  const configDir = path.join(workDir, "docker-config");
  // docker login writes config.json into configDir, so it must exist first.
  spawnSync("mkdir", ["-p", authDir, configDir], { encoding: "utf8" });

  // bcrypt htpasswd with the password on stdin (docker -i keeps stdin open,
  // htpasswd -i reads it) so it never appears in argv.
  const gen = spawnSync(
    "docker",
    ["run", "--rm", "-i", "--entrypoint", "htpasswd", "httpd:alpine", "-niB", username],
    { encoding: "utf8", input: password, timeout: 60_000 }
  );
  assert.equal(gen.status, 0, `htpasswd generation failed: ${gen.stderr}`);
  writeFileSync(path.join(authDir, "htpasswd"), String(gen.stdout));

  const run = docker([
    "run",
    "-d",
    "--name",
    container,
    "-p",
    `${host}:5000`,
    "-e",
    "REGISTRY_AUTH=htpasswd",
    "-e",
    "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
    "-e",
    "REGISTRY_AUTH_HTPASSWD_REALM=DeployKit Registry",
    "-v",
    `${authDir}:/auth:ro`,
    "registry:2.8.3",
  ]);
  assert.equal(run.code, 0, `registry start failed: ${run.stderr}`);

  // Wait for the 401 challenge that proves auth is enforced.
  const deadline = Date.now() + 30_000;
  let challenged = false;
  while (Date.now() < deadline) {
    const check = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://${host}/v2/`], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (String(check.stdout).trim() === "401") {
      challenged = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(challenged, true, "registry never enforced auth (no 401)");

  return {
    host,
    container,
    username,
    password,
    configDir,
    cleanup: () => {
      docker(["rm", "-f", container]);
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

function makeRegistry(host: string): DockerImageRegistry {
  return new DockerImageRegistry({
    config: { registryHost: host, namespace: "deploykit-auth", insecure: true },
    dockerBinary: "docker",
  });
}

test("anonymous push to an authenticated registry is rejected", { timeout: 180_000, skip: SKIP }, async () => {
  const ctx = await startAuthRegistry();
  try {
    docker(["pull", SOURCE_IMAGE]);
    // Isolated DOCKER_CONFIG so no ambient host credentials leak in.
    const isolated = spawnSync("mktemp", ["-d"], { encoding: "utf8" });
    const emptyConfig = String(isolated.stdout).trim();
    const tagged = `${ctx.host}/deploykit-auth/anon:v1`;
    docker(["tag", SOURCE_IMAGE, tagged]);

    const pushed = spawnSync("docker", ["--config", emptyConfig, "push", tagged], {
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.notEqual(pushed.status, 0, "anonymous push must fail against an authenticated registry");
    assert.match(String(pushed.stderr), /unauthorized|denied|no basic auth credentials|authentication required/i);

    rmSync(emptyConfig, { recursive: true, force: true });
    docker(["image", "rm", tagged]);
  } finally {
    ctx.cleanup();
  }
});

test("docker login then push succeeds against an authenticated registry", { timeout: 180_000, skip: SKIP }, async () => {
  const ctx = await startAuthRegistry();
  try {
    const login = await performRegistryLogin({
      dockerBinary: "docker",
      registryHost: ctx.host,
      credentials: { username: ctx.username, password: ctx.password },
      dockerConfigDir: ctx.configDir,
    });
    assert.equal(login.code, 0, `login failed: ${login.stderr}`);
    assert.ok(!login.stderr.includes(ctx.password), "password must never be echoed");

    docker(["pull", SOURCE_IMAGE]);
    const tagged = `${ctx.host}/deploykit-auth/authed:v1`;
    docker(["tag", SOURCE_IMAGE, tagged]);

    const pushed = spawnSync("docker", ["--config", ctx.configDir, "push", tagged], {
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(pushed.status, 0, `authenticated push failed: ${pushed.stderr}`);

    docker(["image", "rm", tagged]);
  } finally {
    ctx.cleanup();
  }
});

test("wrong credentials fail to log in", { timeout: 120_000, skip: SKIP }, async () => {
  const ctx = await startAuthRegistry();
  try {
    const login = await performRegistryLogin({
      dockerBinary: "docker",
      registryHost: ctx.host,
      credentials: { username: ctx.username, password: "definitely-wrong" },
      dockerConfigDir: ctx.configDir,
    });
    assert.notEqual(login.code, 0, "login with wrong password must fail");
    assert.ok(!login.stderr.includes("definitely-wrong"), "password must never be echoed");
  } finally {
    ctx.cleanup();
  }
});
