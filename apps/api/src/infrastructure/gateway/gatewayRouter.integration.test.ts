import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NginxGatewayRouter } from "./nginxGatewayRouter.js";
import { requestViaHost, routeServerName } from "./trafficRouter.js";

const execFileAsync = promisify(execFile);

const PROJECT = "12345678-1234-1234-1234-123456789abc";
const RELEASE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RELEASE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function backend(name: string, body: string): Promise<string> {
  await execFileAsync(
    "docker",
    [
      "container",
      "create",
      "--name",
      name,
      "--network",
      "deploykit-runtime",
      "--label",
      "io.deploykit.managed=true",
      "busybox:stable",
      "sh",
      "-c",
      `mkdir -p /www && printf '${body}' > /www/index.html && httpd -f -v -p 80 -h /www`,
    ],
    { timeout: 60_000 }
  );
  await execFileAsync("docker", ["container", "start", name], {
    timeout: 30_000,
  });
  const raw = await execFileAsync(
    "docker",
    ["container", "inspect", "--format", "{{json .}}", name],
    { timeout: 30_000 }
  );
  const data = JSON.parse(raw.stdout) as {
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  };
  const ip = data.NetworkSettings?.Networks?.["deploykit-runtime"]?.IPAddress;
  assert.ok(ip);
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://${ip}/`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        return ip as string;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error("backend never became reachable");
}

async function throughGateway(
  gatewayIp: string,
  expectBody: string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const { status, body } = await requestViaHost(
        gatewayIp,
        80,
        routeServerName(PROJECT)
      );
      if (status >= 200 && status < 400 && body === expectBody) {
        return;
      }
      last = `HTTP ${status} body=${body.slice(0, 50)}`;
    } catch (error) {
      last = error instanceof Error ? error.message.slice(0, 80) : "request failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`gateway never served expected body: ${last}`);
}

test(
  "gateway switches traffic between live backends without downtime",
  { timeout: 240_000 },
  async () => {
    if (!(await dockerAvailable())) {
      return;
    }
    try {
      await execFileAsync("docker", ["pull", "busybox:stable"], {
        timeout: 120_000,
      });
    } catch {
      return;
    }
    await execFileAsync("docker", ["network", "create", "deploykit-runtime"]).catch(
      () => undefined
    );

    const work = await mkdtemp(path.join(os.tmpdir(), "deploykit-gw-it-"));
    const routesDir = path.join(work, "routes");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(routesDir, { recursive: true });
    await writeFile(
      path.join(work, "nginx.conf"),
      [
        "user nginx;",
        "worker_processes 1;",
        "error_log /var/log/nginx/error.log warn;",
        "pid /var/run/nginx.pid;",
        "events { worker_connections 64; }",
        "http {",
        "    include /etc/nginx/mime.types;",
        "    access_log off;",
        "    include /etc/nginx/routes/*.conf;",
        "}",
        "",
      ].join("\n")
    );
    await writeFile(
      path.join(routesDir, "000-default.conf"),
      "server { listen 80 default_server; return 404; }\n"
    );

    const stamp = Date.now().toString(36);
    const gwName = `dk-gw-it-${stamp}`;
    const backA = `dk-gw-it-a-${stamp}`;
    const backB = `dk-gw-it-b-${stamp}`;
    const created: string[] = [];
    try {
      const ipA = await backend(backA, "version-a");
      created.push(backA);
      const ipB = await backend(backB, "version-b");
      created.push(backB);

      await execFileAsync(
        "docker",
        [
          "container",
          "create",
          "--name",
          gwName,
          "--network",
          "deploykit-runtime",
          "--label",
          "io.deploykit.managed=true",
          "-v",
          `${work}/nginx.conf:/etc/nginx/nginx.conf:ro`,
          "-v",
          `${routesDir}:/etc/nginx/routes`,
          "nginx:alpine",
        ],
        { timeout: 60_000 }
      );
      created.push(gwName);
      await execFileAsync("docker", ["container", "start", gwName], {
        timeout: 30_000,
      });
      const gwRaw = await execFileAsync(
        "docker",
        ["container", "inspect", "--format", "{{json .}}", gwName],
        { timeout: 30_000 }
      );
      const gwIp = (
        JSON.parse(gwRaw.stdout) as {
          NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
        }
      ).NetworkSettings?.Networks?.["deploykit-runtime"]?.IPAddress;
      assert.ok(gwIp);

      const router = new NginxGatewayRouter({
        gatewayContainer: gwName,
        gatewayHost: gwIp,
        routesDir,
      });

      await router.sync({
        projectId: PROJECT,
        releaseId: RELEASE_A,
        containerName: backA,
        containerIp: ipA,
        containerPort: 80,
      });
      await throughGateway(gwIp as string, "version-a");

      await router.sync({
        projectId: PROJECT,
        releaseId: RELEASE_B,
        containerName: backB,
        containerIp: ipB,
        containerPort: 80,
      });
      await router.verifyRoute(
        {
          projectId: PROJECT,
          releaseId: RELEASE_B,
          containerName: backB,
          containerIp: ipB,
          containerPort: 80,
        },
        30_000
      );
      await throughGateway(gwIp as string, "version-b");

      const stored = await router.activeTarget(PROJECT);
      assert.equal(stored?.releaseId, RELEASE_B);

      await router.remove(PROJECT);
      const gone = await router.activeTarget(PROJECT);
      assert.equal(gone, null);
    } finally {
      for (const name of created) {
        await execFileAsync("docker", ["container", "rm", "--force", name]).catch(
          () => undefined
        );
      }
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }
);
