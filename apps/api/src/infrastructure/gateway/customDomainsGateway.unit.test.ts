// Phase 11: multi-domain gateway routing + safe rollback (no Docker needed
// except via fake docker binaries; route verification uses injected fakes).
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  NginxGatewayRouter,
  parseProjectDomains,
  renderProjectRoute,
  routeFileName,
  sanitizeVerifiedDomains,
} from "./nginxGatewayRouter.js";
import { TrafficRouterError } from "./trafficRouter.js";

const PROJECT = "12345678-1234-1234-1234-123456789abc";
const RELEASE = "abcdefab-abcd-abcd-abcd-abcdefabcdef";

function target() {
  return {
    projectId: PROJECT,
    releaseId: RELEASE,
    containerName: "dk-p12345678-dabcdefab",
    containerIp: "172.20.0.5",
    containerPort: 3000,
  };
}

async function fakeDockerBin(logPath: string, failOn: string[] = []): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deploykit-fakedocker-"));
  const script = [
    "#!/bin/sh",
    `LOG="${logPath}"`,
    `FAIL="${failOn.join(",")}"`,
    'printf \'%s\\n\' "$*" >> "$LOG"',
    'case "$*" in',
    ...failOn.map((f) => `  *"${f}"*) exit 1;;`),
    "esac",
    "exit 0",
    "",
  ].join("\n");
  await writeFile(path.join(dir, "docker"), script);
  await chmod(path.join(dir, "docker"), 0o755);
  return dir;
}

test("one project renders multiple verified domains on one upstream", () => {
  const content = renderProjectRoute(target(), ["Example.COM", "www.example.com"]);
  assert.match(content, /server_name dk-p12345678\.deploykit\.local example\.com www\.example\.com/);
  assert.match(content, /upstream dk_p12345678/);
  assert.match(content, /proxy_pass http:\/\/dk_p12345678/);
  // HTTP-01 reserved, no TLS yet.
  assert.match(content, /acme-challenge/);
  assert.ok(!content.includes("listen 443"));
  assert.ok(!content.includes("ssl_certificate"));
  const domains = parseProjectDomains(content);
  assert.ok(domains.includes("example.com"));
  assert.ok(domains.includes("www.example.com"));
});

test("invalid domains never reach the renderer", () => {
  for (const bad of [["evil; reload"], ["../x"], ["localhost"], ["*.example.com"], ["1.2.3.4"]]) {
    assert.throws(() => renderProjectRoute(target(), bad), (e: unknown) => {
      return e instanceof TrafficRouterError;
    });
  }
  assert.deepEqual(sanitizeVerifiedDomains([]), []);
  assert.deepEqual(
    sanitizeVerifiedDomains(["b.example.com", "a.example.com", "a.example.com"]),
    ["a.example.com", "b.example.com"]
  );
});

test("reload failure restores the previous known-good config", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "deploykit-gw-dom-"));
  const logPath = path.join(work, "docker.log");
  await writeFile(logPath, "");
  // Fail the second reload: first sync succeeds, second fails on nginx -t.
  const binOk = await fakeDockerBin(logPath, []);
  const binFail = await fakeDockerBin(logPath, ["nginx -t"]);
  try {
    const good = new NginxGatewayRouter({
      dockerBinary: path.join(binOk, "docker"),
      gatewayContainer: "dk-gateway",
      routesDir: path.join(work, "routes"),
    });
    await good.sync(target(), ["old.example.com"]);
    const before = await readFile(path.join(work, "routes", routeFileName(PROJECT)), "utf8");
    assert.ok(before.includes("old.example.com"));

    const failing = new NginxGatewayRouter({
      dockerBinary: path.join(binFail, "docker"),
      gatewayContainer: "dk-gateway",
      routesDir: path.join(work, "routes"),
    });
    await assert.rejects(failing.sync(target(), ["new.example.com"]));
    const after = await readFile(path.join(work, "routes", routeFileName(PROJECT)), "utf8");
    assert.equal(after, before);
    assert.ok(after.includes("old.example.com"));
    assert.ok(!after.includes("new.example.com"));
    // No timestamped tmp files leak.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(path.join(work, "routes"));
    assert.ok(!files.some((f) => f.includes(".tmp-")), `tmp leak: ${files}`);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rm(binOk, { recursive: true, force: true }).catch(() => undefined);
    await rm(binFail, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("project target stays shared across domain changes", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "deploykit-gw-shared-"));
  const logPath = path.join(work, "docker.log");
  await writeFile(logPath, "");
  const bin = await fakeDockerBin(logPath, []);
  try {
    const router = new NginxGatewayRouter({
      dockerBinary: path.join(bin, "docker"),
      gatewayContainer: "dk-gateway",
      routesDir: path.join(work, "routes"),
    });
    await router.sync(target(), ["a.example.com", "b.example.com"]);
    const content = await readFile(path.join(work, "routes", routeFileName(PROJECT)), "utf8");
    // Single upstream shared by all server names.
    const upstreams = content.match(/upstream dk_p12345678/g) ?? [];
    assert.equal(upstreams.length, 1);
    assert.match(content, /server 172\.20\.0\.5:3000/);
    // Restore helper round-trips.
    const prev = await router.readRawConfig(PROJECT);
    await router.restoreRawConfig(PROJECT, null);
    assert.equal(await router.readRawConfig(PROJECT), null);
    await router.restoreRawConfig(PROJECT, prev);
    assert.equal(await router.readRawConfig(PROJECT), prev);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rm(bin, { recursive: true, force: true }).catch(() => undefined);
  }
});
