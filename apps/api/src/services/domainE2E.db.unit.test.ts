import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pool from "../db/database.js";
import app from "../app.js";
import { createUser } from "./userService.js";
import { createProject } from "./projectService.js";
import { verifyDomain, listDomains, deleteDomainRow } from "./domainService.js";
import { SESSION_COOKIE_NAME } from "../config/sessionConfig.js";
import {
  NginxGatewayRouter,
  routeFileName,
} from "../infrastructure/gateway/nginxGatewayRouter.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const r = await pool.query(`SELECT to_regclass('public.custom_domains') AS c`);
    return r.rows[0].c !== null;
  } catch {
    return false;
  }
}

const PROJECT = "12345678-1234-1234-1234-123456789abc";
const RELEASE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RELEASE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function targetFor(release: string) {
  return {
    projectId: PROJECT,
    releaseId: release,
    containerName: "dk-p12345678-dabcdefab",
    containerIp: "172.20.0.5",
    containerPort: 3000,
  };
}

test("domain follows active release; failed change keeps old route; delete removes alias", async () => {
  if (!(await dbAvailable())) return;
  const work = await mkdtemp(path.join(os.tmpdir(), "deploykit-e2e-gw-"));
  const logPath = path.join(work, "docker.log");
  await writeFile(logPath, "");
  const binDir = await mkdtemp(path.join(os.tmpdir(), "deploykit-e2e-bin-"));
  await writeFile(
    path.join(binDir, "docker"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\nexit 0\n`
  );
  await chmod(path.join(binDir, "docker"), 0o755);

  let server: ReturnType<typeof app.listen> | null = null;
  const userIds: string[] = [];
  const projectIds: string[] = [];
  try {
    server = app.listen(0);
    await new Promise<void>((r) => server!.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    const user = await createUser({ email, password: "correct-horse-123" });
    userIds.push(user.id);
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-123" }),
    });
    assert.equal(loginRes.status, 200);
    const jar = loginRes.headers.getSetCookie().find((h) => h.startsWith(`${SESSION_COOKIE_NAME}=`));
    assert.ok(jar);
    const cookie = jar!.split(";")[0];
    const project = await createProject({
      name: `e2e-dom-${Date.now()}`,
      repositoryUrl: "https://github.com/acme/app.git",
      branch: "main",
      ownerUserId: user.id,
    });
    projectIds.push(project.id);
    const domainName = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example.org`;
    const createdRes = await fetch(`${base}/api/projects/${project.id}/domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ domain: domainName }),
    });
    assert.equal(createdRes.status, 201);
    const created = (await createdRes.json()) as { id: string; status: string; verification: { value: string } };
    assert.equal(created.status, "pending");
    assert.ok(created.verification.value);

    const verified = await verifyDomain(created.id, {
      lookupTxt: async () => [[created.verification.value]],
    });
    assert.equal(verified.row.status, "verified");

    const router = new NginxGatewayRouter({
      dockerBinary: path.join(binDir, "docker"),
      gatewayContainer: "dk-gateway",
      routesDir: path.join(work, "routes"),
    });
    const domains = (await listDomains(project.id))
      .filter((d) => d.status === "verified")
      .map((d) => d.domain);
    await router.sync(targetFor(RELEASE_A), domains);
    const content = await readFile(
      path.join(work, "routes", routeFileName(PROJECT)),
      "utf8"
    );
    assert.ok(content.includes(domainName));
    const log = await readFile(logPath, "utf8");
    assert.ok(log.includes("nginx -t") && log.includes("nginx -s reload"));

    const withAlias = content;
    assert.match(withAlias, /server_name dk-p12345678\.deploykit\.local/);
    assert.match(withAlias, new RegExp(domainName.replace(/\./g, "\\.")));

    await router.sync(targetFor(RELEASE_B), domains);
    const contentB = await readFile(
      path.join(work, "routes", routeFileName(PROJECT)),
      "utf8"
    );
    assert.ok(contentB.includes(domainName));
    assert.ok(contentB.includes(RELEASE_B));

    const failDir = await mkdtemp(path.join(os.tmpdir(), "deploykit-e2e-fail-"));
    await writeFile(
      path.join(failDir, "docker"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\ncase "$*" in *"nginx -t"*) exit 1;; esac\nexit 0\n`
    );
    await chmod(path.join(failDir, "docker"), 0o755);
    const failing = new NginxGatewayRouter({
      dockerBinary: path.join(failDir, "docker"),
      gatewayContainer: "dk-gateway",
      routesDir: path.join(work, "routes"),
    });
    await assert.rejects(failing.sync(targetFor(RELEASE_A), ["evil.example.org"]));
    const kept = await readFile(path.join(work, "routes", routeFileName(PROJECT)), "utf8");
    assert.equal(kept, contentB);
    await rm(failDir, { recursive: true, force: true }).catch(() => undefined);

    const delRes = await fetch(`${base}/api/domains/${created.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    assert.equal(delRes.status, 200);
    assert.equal((await listDomains(project.id)).length, 0);
    await deleteDomainRow(created.id).catch(() => null);
  } finally {
    if (projectIds.length > 0) {
      await pool.query(`DELETE FROM projects WHERE id = ANY($1)`, [projectIds]).catch(() => undefined);
    }
    if (userIds.length > 0) {
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]).catch(() => undefined);
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rm(binDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
