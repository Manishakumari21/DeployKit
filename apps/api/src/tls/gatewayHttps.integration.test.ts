// Phase 11.9 REAL gateway E2E: rendered config against a live nginx:alpine
// container (skipped when Docker or the required images are unavailable).
// Proves: HTTPS serves the release, HTTP redirects only with a valid cert,
// the ACME challenge path bypasses the redirect, and expired certificates
// fall back to plain HTTP without redirecting at broken HTTPS.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { renderProjectRoute } from "../infrastructure/gateway/nginxGatewayRouter.js";
import { requestViaHost, requestViaTlsHost } from "../infrastructure/gateway/trafficRouter.js";
import { SelfSignedAcmeClient } from "../tls/acmeClient.js";
import {
  domainCertDir,
  fullchainPath,
  gatewayCertPaths,
  privateKeyPath,
} from "../tls/certPaths.js";

const execFileAsync = promisify(execFile);

const PROJECT = "12345678-1234-1234-1234-123456789abc";
const RELEASE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function target(ip: string) {
  return {
    projectId: PROJECT,
    releaseId: RELEASE,
    containerName: "dk-p12345678-dabcdefab",
    containerIp: ip,
    containerPort: 80,
  };
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function pullOrSkip(image: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["pull", image], { timeout: 180_000 });
    return true;
  } catch {
    return false;
  }
}

async function backend(network: string, name: string, body: string): Promise<string> {
  await execFileAsync(
    "docker",
    [
      "container", "create", "--name", name, "--network", network,
      "--label", "io.deploykit.managed=true",
      "busybox:stable", "sh", "-c",
      `mkdir -p /www && printf '${body}' > /www/index.html && httpd -f -v -p 80 -h /www`,
    ],
    { timeout: 60_000 }
  );
  await execFileAsync("docker", ["container", "start", name], { timeout: 30_000 });
  const raw = await execFileAsync(
    "docker", ["container", "inspect", "--format", "{{json .}}", name], { timeout: 30_000 }
  );
  const ip = (
    JSON.parse(raw.stdout) as {
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
    }
  ).NetworkSettings?.Networks?.[network]?.IPAddress;
  assert.ok(ip);
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://${ip}/`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return ip as string;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw new Error("backend never became reachable");
}

async function containerIp(network: string, name: string): Promise<string> {
  const raw = await execFileAsync(
    "docker", ["container", "inspect", "--format", "{{json .}}", name], { timeout: 30_000 }
  );
  const ip = (
    JSON.parse(raw.stdout) as {
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
    }
  ).NetworkSettings?.Networks?.[network]?.IPAddress;
  assert.ok(ip);
  return ip as string;
}

// mkdtemp creates 0700 directories, which would hide mounted content from
// the unprivileged nginx workers (master/root reads fine, workers get
// EACCES). Make the fixture tree traversable like the production volume.
async function makeServable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  await chmod(root, 0o755);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await makeServable(full);
    } else if (entry.name !== "private-key.pem") {
      await chmod(full, 0o644);
    }
  }
}

test(
  "nginx serves HTTPS, redirects selectively, and keeps HTTP on expiry",
  { timeout: 300_000 },
  async () => {
    if (!(await dockerAvailable())) return;
    if (!(await pullOrSkip("busybox:stable"))) return;
    if (!(await pullOrSkip("nginx:alpine"))) return;

    const stamp = Date.now().toString(36);
    const network = `dk-tls-it-${stamp}`;
    const back = `dk-tls-back-${stamp}`;
    const gw = `dk-tls-gw-${stamp}`;
    const tlsDomain = `tls-${stamp}.example.org`;
    const plainDomain = `plain-${stamp}.example.org`;
    const created: string[] = [];
    const work = await mkdtemp(path.join(os.tmpdir(), "deploykit-tls-it-"));
    try {
      await execFileAsync("docker", ["network", "create", network], { timeout: 30_000 });
      const backIp = await backend(network, back, "hello-backend");
      created.push(back);

      // Certificate material in worker-side layout, mounted at the gateway path.
      const certsDir = path.join(work, "certs");
      const domainDir = domainCertDir(tlsDomain, certsDir);
      await mkdir(domainDir, { recursive: true, mode: 0o700 });
      const selfSigned = new SelfSignedAcmeClient("openssl", 90);
      const material = await selfSigned.requestCertificate(tlsDomain);
      await writeFile(fullchainPath(tlsDomain, certsDir), material.certificatePem, { mode: 0o644 });
      await writeFile(privateKeyPath(tlsDomain, certsDir), material.privateKeyPem, { mode: 0o600 });

      // Challenge fixture proving the HTTP-01 bypass.
      const challengeFile = path.join(
        certsDir, "challenges", ".well-known", "acme-challenge", "ping"
      );
      await mkdir(path.dirname(challengeFile), { recursive: true });
      await writeFile(challengeFile, "pong", { mode: 0o644 });

      const routesDir = path.join(work, "routes");
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

      const gwPaths = gatewayCertPaths(tlsDomain);
      const rendered = renderProjectRoute(
        target(backIp),
        [tlsDomain, plainDomain],
        [{ domain: tlsDomain, certificateFile: gwPaths.certificate, keyFile: gwPaths.key }]
      );
      await writeFile(path.join(routesDir, "dk-p12345678.conf"), rendered);
      await makeServable(work);

      await execFileAsync(
        "docker",
        [
          "container", "create", "--name", gw, "--network", network,
          "--label", "io.deploykit.managed=true",
          "-v", `${path.join(work, "nginx.conf")}:/etc/nginx/nginx.conf:ro`,
          "-v", `${routesDir}:/etc/nginx/routes`,
          "-v", `${certsDir}:/etc/nginx/certs:ro`,
          "nginx:alpine",
        ],
        { timeout: 60_000 }
      );
      created.push(gw);
      await execFileAsync("docker", ["container", "start", gw], { timeout: 30_000 });
      const gwIp = await containerIp(network, gw);
      // Test + reload inside the gateway (same mechanism as the worker).
      await execFileAsync("docker", ["container", "exec", gw, "nginx", "-t"], { timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 2_000));

      // HTTPS serves the release for the TLS name.
      const https = await requestViaTlsHost(gwIp, 443, tlsDomain);
      assert.ok(https.status >= 200 && https.status < 400, `HTTPS status ${https.status}`);
      assert.equal(https.body, "hello-backend");

      // HTTP on the TLS name redirects to HTTPS (Let’s Encrypt validates
      // port 80, so the check below runs first for challenge paths).
      const redir = await requestViaHost(gwIp, 80, tlsDomain);
      assert.equal(redir.status, 301);

      // Challenge path bypasses the redirect and serves the file.
      const challenge = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        import("node:net").then(({ Socket }) => {
          const socket = new Socket();
          let data = "";
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("challenge check timed out"));
          }, 5_000);
          socket.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          socket.connect(80, gwIp, () => {
            socket.write(
              `GET /.well-known/acme-challenge/ping HTTP/1.1\r\nHost: ${tlsDomain}\r\nConnection: close\r\n\r\n`
            );
          });
          socket.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          socket.on("close", () => {
            clearTimeout(timer);
            const headEnd = data.indexOf("\r\n\r\n");
            resolve({
              status: Number(/HTTP\/1\.1 (\d+)/.exec(data.slice(0, headEnd))?.[1] ?? 0),
              body: headEnd === -1 ? "" : data.slice(headEnd + 4),
            });
          });
        }).catch(reject);
      });
      assert.equal(challenge.status, 200);
      assert.equal(challenge.body, "pong");

      // Plain verified domain stays on HTTP with no redirect.
      const plain = await requestViaHost(gwIp, 80, plainDomain);
      assert.ok(plain.status >= 200 && plain.status < 400, `plain status ${plain.status}`);
      assert.equal(plain.body, "hello-backend");

      // Expired/missing certificate: re-render without the TLS entry (the
      // sweeper + reconverge path) and prove HTTP remains with no redirect.
      const downgraded = renderProjectRoute(target(backIp), [tlsDomain, plainDomain], []);
      await writeFile(path.join(routesDir, "dk-p12345678.conf"), downgraded);
      await execFileAsync("docker", ["container", "exec", gw, "nginx", "-t"], { timeout: 30_000 });
      await execFileAsync("docker", ["container", "exec", gw, "nginx", "-s", "reload"], { timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 2_000));
      const kept = await requestViaHost(gwIp, 80, tlsDomain);
      assert.ok(kept.status >= 200 && kept.status < 400, `kept status ${kept.status}`);
      assert.equal(kept.body, "hello-backend");

      // Rendered material sanity: no key bytes in nginx config.
      const onDisk = await readFile(path.join(routesDir, "dk-p12345678.conf"), "utf8");
      assert.ok(!onDisk.includes("PRIVATE KEY"));
    } finally {
      for (const name of created) {
        await execFileAsync("docker", ["container", "rm", "--force", name]).catch(() => undefined);
      }
      await execFileAsync("docker", ["network", "rm", network]).catch(() => undefined);
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }
);
