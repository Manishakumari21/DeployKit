// Phase 11.8–11.10: issuance orchestration over real PG + temp filesystem.
// ACME is faked (delegating to openssl self-signed material); gateway Docker
// calls use a fake binary; HTTPS verification uses injected stubs so no live
// gateway is needed. Real-E2E against nginx lives in gatewayHttps tests.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pool from "../db/database.js";
import { createProject } from "./projectService.js";
import { createUser } from "./userService.js";
import {
  createDomain,
  verifyDomain,
  type DomainRow,
} from "./domainService.js";
import {
  claimDueCertificates,
  requestCertificate,
} from "./certService.js";
import {
  gcOrphanCertificates,
  processCertificateClaim,
  runCertificateMaintenance,
} from "./certIssuanceService.js";
import { NginxGatewayRouter } from "../infrastructure/gateway/nginxGatewayRouter.js";
import type { RouteTarget, TrafficRouter } from "../infrastructure/gateway/trafficRouter.js";
import { FakeAcmeClient, SelfSignedAcmeClient } from "../tls/acmeClient.js";
import { fullchainPath, privateKeyPath } from "../tls/certPaths.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(`SELECT to_regclass('public.custom_domains') AS c`);
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

async function opensslAvailable(): Promise<boolean> {
  try {
    const { runCommand } = await import("../infrastructure/process/dockerExec.js");
    return (await runCommand("openssl", ["version"], 10_000)).code === 0;
  } catch {
    return false;
  }
}

const userIds: string[] = [];
const projectIds: string[] = [];

async function makeVerifiedDomain(tag: string): Promise<{ projectId: string; row: DomainRow }> {
  const user = await createUser({
    email: `phase11-iss-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
    password: "correct-horse-123",
  });
  userIds.push(user.id);
  const project = await createProject({
    name: `iss-${tag}-${Date.now()}`,
    repositoryUrl: "https://github.com/acme/app.git",
    branch: "main",
    ownerUserId: user.id,
  });
  projectIds.push(project.id);
  const domain = `iss-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example.org`;
  const created = await createDomain({ projectId: project.id, domain });
  const verified = await verifyDomain(created.row.id, {
    lookupTxt: async () => [[created.verificationToken]],
  });
  return { projectId: project.id, row: verified.row };
}

async function teardown(): Promise<void> {
  if (projectIds.length > 0) {
    await pool.query(`DELETE FROM projects WHERE id = ANY($1)`, [projectIds]);
    projectIds.length = 0;
  }
  if (userIds.length > 0) {
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
    userIds.length = 0;
  }
}

interface TempEnv {
  certsRoot: string;
  routesDir: string;
  logPath: string;
  binDir: string;
  real: NginxGatewayRouter;
}

async function makeTempEnv(): Promise<TempEnv> {
  const work = await mkdtemp(path.join(os.tmpdir(), "deploykit-iss-"));
  const certsRoot = path.join(work, "certs");
  const routesDir = path.join(work, "routes");
  const logPath = path.join(work, "docker.log");
  await writeFile(logPath, "");
  const binDir = await mkdtemp(path.join(os.tmpdir(), "deploykit-iss-bin-"));
  await writeFile(binDir + "/docker", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\nexit 0\n`);
  await chmod(path.join(binDir, "docker"), 0o755);
  const real = new NginxGatewayRouter({
    dockerBinary: path.join(binDir, "docker"),
    gatewayContainer: "dk-gateway",
    gatewayHost: "dk-gateway",
    routesDir,
    challengeRoot: path.join(certsRoot, "challenges"),
  });
  return { certsRoot, routesDir, logPath, binDir, real };
}

async function cleanupEnv(env: TempEnv): Promise<void> {
  const { certsRoot, binDir } = env;
  await rm(path.dirname(certsRoot), { recursive: true, force: true }).catch(() => undefined);
  await rm(binDir, { recursive: true, force: true }).catch(() => undefined);
}

// Stub router: real file behavior, injected verification outcomes.
function stubRouter(
  real: NginxGatewayRouter,
  outcomes: { https?: "ok" | "fail"; http?: "ok" | "fail" } = {}
): TrafficRouter & { calls: string[] } {
  const calls: string[] = [];
  const stub = {
    calls,
    sync: (...args: Parameters<TrafficRouter["sync"]>) => {
      calls.push("sync");
      return real.sync(...args);
    },
    verifyRoute: async () => {
      calls.push("verifyRoute");
      if (outcomes.http === "fail") throw new Error("HTTP route check failed");
    },
    verifyHttpsRoute: async () => {
      calls.push("verifyHttpsRoute");
      if (outcomes.https === "fail") throw new Error("HTTPS route check failed");
    },
    readRawConfig: (id: string) => real.readRawConfig(id),
    restoreRawConfig: (id: string, prev: string | null) => real.restoreRawConfig(id, prev),
    remove: (id: string) => real.remove(id),
    activeTarget: (id: string) => real.activeTarget(id),
  };
  return stub;
}

// Fake ACME backed by real openssl-generated PEMs (pre-generated because the
// fake's handler contract is synchronous). Deterministic per domain.
async function fakeAcmeWithRealMaterial(domain: string): Promise<FakeAcmeClient> {
  const selfSigned = new SelfSignedAcmeClient("openssl", 90);
  const material = await selfSigned.requestCertificate(domain);
  return new FakeAcmeClient(() => material);
}

test("successful issuance installs files atomically and marks issued", async () => {
  if (!(await dbAvailable()) || !(await opensslAvailable())) return;
  const env = await makeTempEnv();
  const { row } = await makeVerifiedDomain("ok").catch(async (e) => {
    await cleanupEnv(env);
    throw e;
  });
  try {
    const acme = await fakeAcmeWithRealMaterial(row.domain);
    await requestCertificate(row.id);
    const claimed = await claimDueCertificates(5);
    assert.ok(claimed.some((r) => r.id === row.id));
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };
    let done;
    try {
      done = await processCertificateClaim(claimed.find((r) => r.id === row.id)!, {
        acmeClient: acme,
        router: stubRouter(env.real),
        certsRoot: env.certsRoot,
      });
    } finally {
      console.log = origLog;
    }
    assert.equal(done.tls_status, "issued");
    assert.ok(done.cert_expires_at);
    assert.equal(done.cert_path, `domains/${row.domain}`);
    const certStat = await stat(fullchainPath(row.domain, env.certsRoot));
    const keyStat = await stat(privateKeyPath(row.domain, env.certsRoot));
    assert.equal(certStat.mode & 0o777, 0o644);
    assert.equal(keyStat.mode & 0o777, 0o600);
    const flat = logs.join("\n");
    assert.ok(!flat.includes("PRIVATE KEY"));
    assert.ok(!flat.includes("BEGIN RSA"));
    const flatRow = JSON.stringify(done);
    assert.ok(!flatRow.includes("PRIVATE KEY"));
    // verification_token_hash lives on the internal row by design; the API
    // boundary (toPublicDomain) strips it — covered by domainAuth tests.
  } finally {
    await teardown();
    await cleanupEnv(env);
  }
});

test("ACME failure records failed without touching files or gateway", async () => {
  if (!(await dbAvailable()) || !(await opensslAvailable())) return;
  const env = await makeTempEnv();
  const { row } = await makeVerifiedDomain("acmefail");
  try {
    const { AcmeError } = await import("../tls/acmeClient.js");
    const acme = new FakeAcmeClient(() => {
      throw new AcmeError("ACME_REQUEST_FAILED", "connection refused");
    });
    await requestCertificate(row.id);
    const claimed = await claimDueCertificates(5);
    await assert.rejects(
      processCertificateClaim(claimed.find((r) => r.id === row.id)!, {
        acmeClient: acme,
        router: stubRouter(env.real),
        certsRoot: env.certsRoot,
      })
    );
    const after = (await import("./domainService.js")).getDomainById(row.id);
    assert.equal((await after)?.tls_status, "failed");
    assert.equal((await after)?.tls_last_error_code, "ACME_REQUEST_FAILED");
    await assert.rejects(readFile(fullchainPath(row.domain, env.certsRoot), "utf8"));
  } finally {
    await teardown();
    await cleanupEnv(env);
  }
});

test("gateway HTTPS failure restores previous files and keeps serving", async () => {
  if (!(await dbAvailable()) || !(await opensslAvailable())) return;
  const env = await makeTempEnv();
  const { row } = await makeVerifiedDomain("gwfail");
  try {
    const acme = await fakeAcmeWithRealMaterial(row.domain);
    // First issuance succeeds (no active runtime, so no gateway involved).
    await requestCertificate(row.id);
    let claimed = await claimDueCertificates(5);
    await processCertificateClaim(claimed.find((r) => r.id === row.id)!, {
      acmeClient: acme,
      router: stubRouter(env.real),
      certsRoot: env.certsRoot,
    });
    const beforeCert = await readFile(fullchainPath(row.domain, env.certsRoot), "utf8");
    const beforeKey = await readFile(privateKeyPath(row.domain, env.certsRoot), "utf8");
    // Renewal attempt whose gateway activation fails. The row is already
    // in-flight (renewing), so it is not re-claimable — pass it directly,
    // exactly as the worker does with the claim it already holds.
    await requestCertificate(row.id);
    const { getDomainById: getById } = await import("./domainService.js");
    const renewalRow = await getById(row.id);
    assert.equal(renewalRow?.tls_status, "renewing");
    const router = stubRouter(env.real, { https: "fail" });
    // Give the claim an active runtime so gateway convergence is attempted.
    const deployment = await pool.query(
      `INSERT INTO deployments (project_id, status, trigger, branch) VALUES ($1, 'active', 'manual', 'main') RETURNING id`,
      [row.project_id]
    );
    const deploymentId = deployment.rows[0].id as string;
    const release = await pool.query(
      `INSERT INTO releases (deployment_id, project_id, image_repository, image_digest, commit_sha, branch, status)
       VALUES ($1, $2, 'example/app', $3, $4, 'main', 'active') RETURNING id`,
      [deploymentId, row.project_id, `sha256:${"b".repeat(64)}`, "c".repeat(40)]
    );
    await pool.query(
      `INSERT INTO runtime_instances (release_id, status, container_name, container_id, container_port, host_port, ip_address)
       VALUES ($1, 'running', $2, $3, 3000, 3000, '172.20.0.9')`,
      [release.rows[0].id, `dk-p${Date.now().toString(16).slice(-8)}-d${Date.now().toString(16).slice(-8)}`, `${"d".repeat(64)}`]
    );
    await assert.rejects(
      processCertificateClaim(renewalRow!, {
        acmeClient: acme,
        router,
        certsRoot: env.certsRoot,
      })
    );
    // Previous valid files restored byte-for-byte; row reverted to issued.
    assert.equal(await readFile(fullchainPath(row.domain, env.certsRoot), "utf8"), beforeCert);
    assert.equal(await readFile(privateKeyPath(row.domain, env.certsRoot), "utf8"), beforeKey);
    const { getDomainById } = await import("./domainService.js");
    const after = await getDomainById(row.id);
    assert.equal(after?.tls_status, "issued");
    assert.equal(after?.tls_last_error_code, "GATEWAY_TLS_FAILED");
    assert.ok(router.calls.includes("verifyHttpsRoute"));
  } finally {
    await teardown();
    await cleanupEnv(env);
  }
});

test("orphan certificate directories are reclaimed, live ones kept", async () => {
  if (!(await dbAvailable())) return;
  const env = await makeTempEnv();
  const { row } = await makeVerifiedDomain("gc");
  try {
    const { mkdir, writeFile: write } = await import("node:fs/promises");
    await mkdir(path.join(env.certsRoot, "domains", row.domain), { recursive: true });
    await write(path.join(env.certsRoot, "domains", row.domain, "fullchain.pem"), "x");
    await mkdir(path.join(env.certsRoot, "domains", "ghost.example.org"), { recursive: true });
    await write(path.join(env.certsRoot, "domains", "ghost.example.org", "fullchain.pem"), "x");
    const removed = await gcOrphanCertificates(env.certsRoot);
    assert.equal(removed, 1);
    await assert.rejects(readFile(path.join(env.certsRoot, "domains", "ghost.example.org", "fullchain.pem"), "utf8"));
    assert.equal(
      await readFile(path.join(env.certsRoot, "domains", row.domain, "fullchain.pem"), "utf8"),
      "x"
    );
  } finally {
    await teardown();
    await cleanupEnv(env);
  }
});

test("maintenance sweep issues due claims end to end", async () => {
  if (!(await dbAvailable()) || !(await opensslAvailable())) return;
  const env = await makeTempEnv();
  const { row } = await makeVerifiedDomain("sweep");
  try {
    const acme = await fakeAcmeWithRealMaterial(row.domain);
    await requestCertificate(row.id);
    const summary = await runCertificateMaintenance({
      acmeClient: acme,
      router: stubRouter(env.real),
      certsRoot: env.certsRoot,
    });
    assert.equal(summary.claimed, 1);
    assert.equal(summary.issued, 1);
    assert.equal(summary.failed, 0);
    const { getDomainById } = await import("./domainService.js");
    assert.equal((await getDomainById(row.id))?.tls_status, "issued");
  } finally {
    await teardown();
    await cleanupEnv(env);
  }
});
