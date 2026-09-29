import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { DockerRuntimeManager } from "./dockerRuntimeManager.js";

const execFileAsync = promisify(execFile);

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

test(
  "DockerRuntimeManager lifecycle with digest-pinned busybox server",
  { timeout: 240_000 },
  async () => {
    if (!(await dockerAvailable())) {
      return;
    }
    await execFileAsync("docker", [
      "network",
      "create",
      "deploykit-runtime",
    ]).catch(() => undefined);

    const manager = new DockerRuntimeManager();
    const name = `dk-it-${Date.now().toString(36)}`;

    // Digest enforcement stays active: mutable tags are rejected.
    await assert.rejects(
      manager.create({
        containerName: `${name}-rej`,
        imageReference: "deploykit/app:latest",
        networkName: "deploykit-runtime",
        containerPort: 80,
        environment: {},
        healthPath: "/",
        memoryBytes: 256 * 1024 * 1024,
        cpuLimit: 1,
        pidsLimit: 128,
      }),
      /immutable digest/
    );

    // Build a minimal read-only-compatible server (busybox httpd) and
    // capture its immutable manifest digest via buildx metadata.
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "deploykit-runtime-test-")
    );
    const tag = `itest-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const localRef = `deploykit/runtime-test:${tag}`;
    const metaDir = await mkdtemp(
      path.join(os.tmpdir(), "deploykit-rt-meta-")
    );
    const metaFile = path.join(metaDir, "metadata.json");
    let digestRef = "";
    try {
      await writeFile(
        path.join(workspace, "Dockerfile"),
        `FROM busybox:stable\nRUN mkdir -p /www && echo ok > /www/index.html\nEXPOSE 80\nCMD ["httpd","-f","-v","-p","80","-h","/www"]\n`
      );
      await execFileAsync(
        "docker",
        [
          "buildx",
          "build",
          "--builder",
          process.env.DEPLOYKIT_BUILDER_NAME ?? "deploykit-builder",
          "--load",
          "--metadata-file",
          metaFile,
          "--tag",
          localRef,
          workspace,
        ],
        { timeout: 180_000 }
      );
      const meta = JSON.parse(await readFile(metaFile, "utf8")) as Record<
        string,
        unknown
      >;
      const digest = meta["containerimage.digest"];
      assert.equal(typeof digest, "string");
      assert.match(digest as string, /^sha256:[0-9a-f]{64}$/i);
      digestRef = `${localRef}@${digest}`;
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(
        () => undefined
      );
      await rm(metaDir, { recursive: true, force: true }).catch(
        () => undefined
      );
    }

    let created = false;
    try {
      const createdInfo = await manager.create({
        containerName: name,
        imageReference: digestRef,
        networkName: "deploykit-runtime",
        containerPort: 80,
        environment: {},
        healthPath: "/",
        memoryBytes: 256 * 1024 * 1024,
        cpuLimit: 1,
        pidsLimit: 128,
      });
      created = true;
      assert.equal(createdInfo.containerName, name);
      assert.equal(createdInfo.networkName, "deploykit-runtime");

      await manager.start(name);
      const info = await manager.inspect(name, "deploykit-runtime");
      assert.equal(info.containerName, name);
      assert.equal(info.networkName, "deploykit-runtime");
      assert.ok(info.ipAddress);
      assert.equal(info.containerPort, 80);
      assert.equal(info.healthPath, "/");

      await manager.waitForHealthy(info, 60_000);
    } finally {
      if (created) {
        await manager.stop(name).catch(() => undefined);
        await manager.remove(name).catch(() => undefined);
      }
      await execFileAsync("docker", [
        "image",
        "rm",
        "-f",
        localRef,
      ]).catch(() => undefined);
    }
  }
);
