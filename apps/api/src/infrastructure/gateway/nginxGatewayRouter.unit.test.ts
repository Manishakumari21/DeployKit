import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  NginxGatewayRouter,
  routeFileName,
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

async function fakeDockerBin(logPath: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deploykit-fakedocker-"));
  await writeFile(
    path.join(dir, "docker"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\nexit 0\n`
  );
  await chmod(path.join(dir, "docker"), 0o755);
  return dir;
}

test("sync writes the route atomically then tests and reloads", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "deploykit-gw-"));
  const logPath = path.join(work, "docker.log");
  await writeFile(logPath, "");
  const bin = await fakeDockerBin(logPath);
  try {
    const router = new NginxGatewayRouter({
      dockerBinary: path.join(bin, "docker"),
      gatewayContainer: "dk-gateway",
      routesDir: path.join(work, "routes"),
    });
    await router.sync(target());
    const content = await readFile(
      path.join(work, "routes", routeFileName(PROJECT)),
      "utf8"
    );
    assert.match(content, new RegExp(RELEASE));
    assert.ok(!content.includes("PRIVATE") && !content.includes("TOKEN"));
    const log = await readFile(logPath, "utf8");
    const testIdx = log.indexOf("nginx -t");
    const reloadIdx = log.indexOf("nginx -s reload");
    assert.ok(testIdx !== -1 && reloadIdx !== -1 && testIdx < reloadIdx);
    const stored = await router.activeTarget(PROJECT);
    assert.deepEqual(stored, target());
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rm(bin, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("remove deletes the route and reloads", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "deploykit-gw-"));
  const logPath = path.join(work, "docker.log");
  await writeFile(logPath, "");
  const bin = await fakeDockerBin(logPath);
  try {
    const routesDir = path.join(work, "routes");
    await mkdir(routesDir, { recursive: true });
    await writeFile(path.join(routesDir, routeFileName(PROJECT)), "stale");
    const router = new NginxGatewayRouter({
      dockerBinary: path.join(bin, "docker"),
      gatewayContainer: "dk-gateway",
      routesDir,
    });
    await router.remove(PROJECT);
    assert.equal(await router.activeTarget(PROJECT), null);
    const log = await readFile(logPath, "utf8");
    assert.ok(log.includes("nginx -s reload"));
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rm(bin, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("invalid gateway and target values are rejected", async () => {
  assert.throws(
    () =>
      new NginxGatewayRouter({
        dockerBinary: "/bin/true",
        gatewayContainer: "bad name!",
        routesDir: os.tmpdir(),
      }),
    (error: unknown) => {
      assert.ok(error instanceof TrafficRouterError);
      return true;
    }
  );
  const router = new NginxGatewayRouter({
    dockerBinary: "/bin/true",
    gatewayContainer: "dk-gateway",
    routesDir: os.tmpdir(),
  });
  await assert.rejects(
    router.sync({ ...target(), containerIp: "evil" }),
    (error: unknown) => {
      assert.ok(error instanceof TrafficRouterError);
      return true;
    }
  );
  await assert.rejects(
    router.verifyRoute(target(), 0),
    (error: unknown) => {
      assert.ok(error instanceof TrafficRouterError);
      return true;
    }
  );
});
