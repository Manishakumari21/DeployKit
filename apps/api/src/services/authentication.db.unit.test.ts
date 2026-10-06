// Phase 10 Step 4: login/logout/cookies plus authorization preservation,
// exercised over real HTTP against the Express app and real PostgreSQL.
// No mocks for session or membership behavior.
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import pool from "../db/database.js";
import app from "../app.js";
import { createUser } from "./userService.js";
import { createProject } from "./projectService.js";
import { createDeployment } from "./deploymentService.js";
import { createRelease } from "./releaseService.js";
import {
  getSessionLifetimeMs,
  isCookieSecure,
  SESSION_COOKIE_NAME,
} from "../config/sessionConfig.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SHA = "b".repeat(40);

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.sessions') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

function uniqueEmail(tag: string): string {
  const rand = Math.floor(Math.random() * 1_000_000);
  return `phase10-e2e-${tag}-${Date.now()}-${rand}@example.com`;
}

interface Fixture {
  base: string;
  alice: { id: string; email: string };
  bob: { id: string; email: string };
  projectId: string;
  legacyProjectId: string;
  deploymentId: string;
  releaseId: string;
}

let server: ReturnType<typeof app.listen> | null = null;
let fixture: Fixture | null = null;
const userIds: string[] = [];
const projectIds: string[] = [];

async function api(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string | null } = {}
): Promise<{ status: number; json: unknown; cookies: string[] }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = await res.json().catch(() => ({}));
  return {
    status: res.status,
    json,
    cookies: res.headers.getSetCookie(),
  };
}

function sessionCookie(cookies: string[]): string | null {
  for (const header of cookies) {
    const [pair] = header.split(";");
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index).trim() === SESSION_COOKIE_NAME) {
      return `${SESSION_COOKIE_NAME}=${pair.slice(index + 1).trim()}`;
    }
  }
  return null;
}

async function setup(): Promise<Fixture | null> {
  if (!(await dbAvailable())) return null;
  if (!server) {
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
  }
  if (fixture) return fixture;
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const alice = await createUser({ email: uniqueEmail("alice"), password: "correct-horse-123" });
  const bob = await createUser({ email: uniqueEmail("bob"), password: "correct-horse-123" });
  userIds.push(alice.id, bob.id);
  const project = await createProject({
    name: `e2e-owned-${Date.now()}`,
    repositoryUrl: "https://github.com/acme/app.git",
    branch: "main",
    ownerUserId: alice.id,
  });
  const legacy = await createProject({
    name: `e2e-legacy-${Date.now()}`,
    repositoryUrl: "https://github.com/acme/legacy.git",
    branch: "main",
  });
  projectIds.push(project.id, legacy.id);
  const deployment = await createDeployment({
    projectId: project.id,
    trigger: "manual",
    idempotencyKey: `e2e-${Date.now()}`,
  });
  assert.ok(deployment);
  const release = await createRelease({
    deploymentId: (deployment as { id: string }).id,
    projectId: project.id,
    imageRepository: "example/app",
    imageDigest: DIGEST,
    commitSha: SHA,
    branch: "main",
    supersedesReleaseId: null,
  });
  fixture = {
    base,
    alice: { id: alice.id, email: alice.email },
    bob: { id: bob.id, email: bob.email },
    projectId: project.id,
    legacyProjectId: legacy.id,
    deploymentId: (deployment as { id: string }).id,
    releaseId: (release as { id: string }).id,
  };
  return fixture;
}

async function login(
  base: string,
  email: string,
  password: string
): Promise<{ status: number; json: unknown; cookies: string[] }> {
  return api(base, "/api/auth/login", { method: "POST", body: { email, password } });
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
  fixture = null;
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((e: unknown) => (e ? reject(e) : resolve()))
    );
    server = null;
  }
}

// ---- Login ----

test("successful login returns the user, never secrets, and sets a secure cookie", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    const res = await login(fx.base, fx.alice.email, "correct-horse-123");
    assert.equal(res.status, 200);
    const body = res.json as Record<string, unknown>;
    assert.equal(body.email, fx.alice.email);
    assert.equal(body.id, fx.alice.id);
    assert.ok(!("password_hash" in body), "hash must never be returned");
    assert.ok(!("password" in body));
    const flat = JSON.stringify(body);
    assert.ok(!flat.includes("password_hash"));
    const jar = sessionCookie(res.cookies);
    assert.ok(jar, "login must set the session cookie");
    const header = res.cookies.find((h) => h.startsWith(`${SESSION_COOKIE_NAME}=`));
    assert.ok(header);
    assert.ok(header.includes("HttpOnly"), "cookie must be HttpOnly");
    assert.ok(header.includes("SameSite=Lax"), "cookie must be SameSite=Lax");
    assert.ok(header.includes("Path=/"), "cookie must be Path=/");
    assert.ok(header.includes("Max-Age="), "cookie must carry Max-Age");
    assert.ok(!flat.includes(jar.split("=")[1]), "raw token must not be in JSON");
    // The session actually authenticates.
    const me = await api(fx.base, "/api/projects", { cookie: jar });
    assert.equal(me.status, 200);
  } finally {
    await teardown();
  }
});

test("wrong password and unknown email fail identically with 401", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    const wrong = await login(fx.base, fx.alice.email, "wrong-password-xyz");
    assert.equal(wrong.status, 401);
    const ghost = await login(fx.base, uniqueEmail("ghost"), "correct-horse-123");
    assert.equal(ghost.status, 401);
    assert.deepEqual(ghost.json, wrong.json);
    assert.deepEqual(wrong.json, { error: "Invalid email or password" });
    assert.equal(sessionCookie(wrong.cookies), null);
    assert.equal(sessionCookie(ghost.cookies), null);
  } finally {
    await teardown();
  }
});

test("malformed login bodies are rejected with 400", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    for (const body of [{}, { email: fx.alice.email }, { password: "x" }, null, []]) {
      const res = await api(fx.base, "/api/auth/login", { method: "POST", body });
      assert.equal(res.status, 400);
    }
  } finally {
    await teardown();
  }
});

test("login creates no project membership", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    await login(fx.base, fx.bob.email, "correct-horse-123");
    const count = (
      await pool.query(`SELECT COUNT(*)::int AS n FROM project_members WHERE user_id = $1`, [
        fx.bob.id,
      ])
    ).rows[0].n;
    assert.equal(count, 0);
  } finally {
    await teardown();
  }
});

// ---- Logout ----

test("logout revokes the session, clears the cookie, and is repeatable", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    const logged = await login(fx.base, fx.alice.email, "correct-horse-123");
    const jar = sessionCookie(logged.cookies);
    assert.ok(jar);
    const first = await api(fx.base, "/api/auth/logout", { method: "POST", cookie: jar });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { loggedOut: true });
    const cleared = first.cookies.find((h) => h.startsWith(`${SESSION_COOKIE_NAME}=`));
    assert.ok(cleared && /Expires=Thu, 01 Jan 1970|Max-Age=0/.test(cleared));
    const reused = await api(fx.base, "/api/projects", { cookie: jar });
    assert.equal(reused.status, 401);
    const second = await api(fx.base, "/api/auth/logout", { method: "POST", cookie: jar });
    assert.equal(second.status, 200);
    const bare = await api(fx.base, "/api/auth/logout", { method: "POST" });
    assert.equal(bare.status, 200);
  } finally {
    await teardown();
  }
});

// ---- Authorization preservation ----

test("project access: owner allowed, stranger and legacy denied, anonymous 401", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    const aliceJar = sessionCookie((await login(fx.base, fx.alice.email, "correct-horse-123")).cookies);
    const bobJar = sessionCookie((await login(fx.base, fx.bob.email, "correct-horse-123")).cookies);
    assert.ok(aliceJar && bobJar);
    assert.equal((await api(fx.base, `/api/projects/${fx.projectId}`, { cookie: aliceJar })).status, 200);
    const denied = await api(fx.base, `/api/projects/${fx.projectId}`, { cookie: bobJar });
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.json, { error: "Access denied" });
    assert.equal(
      (await api(fx.base, `/api/projects/${fx.legacyProjectId}`, { cookie: aliceJar })).status,
      403
    );
    assert.equal((await api(fx.base, `/api/projects/${fx.projectId}`)).status, 401);
    assert.equal(
      (await api(fx.base, `/api/projects/${fx.projectId}`, { cookie: `${SESSION_COOKIE_NAME}=bogus` }))
        .status,
      401
    );
  } finally {
    await teardown();
  }
});

test("project listing returns only member projects", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    const aliceJar = sessionCookie((await login(fx.base, fx.alice.email, "correct-horse-123")).cookies);
    const bobJar = sessionCookie((await login(fx.base, fx.bob.email, "correct-horse-123")).cookies);
    assert.ok(aliceJar && bobJar);
    const aliceList = (await api(fx.base, "/api/projects", { cookie: aliceJar })).json as Array<{
      id: string;
    }>;
    const ids = aliceList.map((p) => p.id);
    assert.ok(ids.includes(fx.projectId));
    assert.ok(!ids.includes(fx.legacyProjectId), "unowned projects must not leak into listing");
    const bobList = (await api(fx.base, "/api/projects", { cookie: bobJar })).json as Array<{
      id: string;
    }>;
    assert.deepEqual(bobList, []);
    assert.equal((await api(fx.base, "/api/projects")).status, 401);
  } finally {
    await teardown();
  }
});

test("project creation assigns ownership to the caller atomically", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    const bobJar = sessionCookie((await login(fx.base, fx.bob.email, "correct-horse-123")).cookies);
    assert.ok(bobJar);
    const created = await api(fx.base, "/api/projects", {
      method: "POST",
      cookie: bobJar,
      body: { name: `bob-svc-${Date.now()}`, repositoryUrl: "https://github.com/acme/bob.git", branch: "main" },
    });
    assert.equal(created.status, 201);
    const id = (created.json as { id: string }).id;
    projectIds.push(id);
    assert.equal((await api(fx.base, `/api/projects/${id}`, { cookie: bobJar })).status, 200);
    const aliceJar = sessionCookie((await login(fx.base, fx.alice.email, "correct-horse-123")).cookies);
    assert.equal((await api(fx.base, `/api/projects/${id}`, { cookie: aliceJar })).status, 403);
    assert.equal((await api(fx.base, "/api/projects", { method: "POST" })).status, 401);
  } finally {
    await teardown();
  }
});

test("deployment routes resolve the owning project for authorization", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    const aliceJar = sessionCookie((await login(fx.base, fx.alice.email, "correct-horse-123")).cookies);
    const bobJar = sessionCookie((await login(fx.base, fx.bob.email, "correct-horse-123")).cookies);
    assert.ok(aliceJar && bobJar);
    assert.equal(
      (await api(fx.base, `/api/deployments/${fx.deploymentId}`, { cookie: aliceJar })).status,
      200
    );
    assert.equal(
      (await api(fx.base, `/api/deployments/${fx.deploymentId}`, { cookie: bobJar })).status,
      403
    );
    assert.equal((await api(fx.base, `/api/deployments/${fx.deploymentId}`)).status, 401);
    assert.equal(
      (
        await api(fx.base, `/api/deployments/00000000-0000-0000-0000-000000000000`, {
          cookie: aliceJar,
        })
      ).status,
      404
    );
    assert.equal(
      (await api(fx.base, `/api/deployments/${fx.deploymentId}/events`, { cookie: bobJar }))
        .status,
      403
    );
    assert.equal(
      (await api(fx.base, `/api/deployments/${fx.deploymentId}/logs`, { cookie: aliceJar }))
        .status,
      200
    );
    const logs = (await api(fx.base, `/api/deployments/${fx.deploymentId}/logs`, {
      cookie: aliceJar,
    })).json as { items: unknown[] };
    assert.ok(Array.isArray(logs.items));
    // Stranger cannot cancel; owner can.
    assert.equal(
      (
        await api(fx.base, `/api/deployments/${fx.deploymentId}/cancel`, {
          method: "POST",
          cookie: bobJar,
        })
      ).status,
      403
    );
    assert.equal(
      (
        await api(fx.base, `/api/deployments/${fx.deploymentId}/cancel`, {
          method: "POST",
          cookie: aliceJar,
        })
      ).status,
      200
    );
    // Project-scoped deployment listing follows the same boundary.
    assert.equal(
      (await api(fx.base, `/api/projects/${fx.projectId}/deployments`, { cookie: aliceJar }))
        .status,
      200
    );
    assert.equal(
      (await api(fx.base, `/api/projects/${fx.projectId}/deployments`, { cookie: bobJar }))
        .status,
      403
    );
  } finally {
    await teardown();
  }
});

test("release, metrics, rollback, and github-link routes enforce membership", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    const aliceJar = sessionCookie((await login(fx.base, fx.alice.email, "correct-horse-123")).cookies);
    const bobJar = sessionCookie((await login(fx.base, fx.bob.email, "correct-horse-123")).cookies);
    assert.ok(aliceJar && bobJar);
    assert.equal(
      (await api(fx.base, `/api/projects/${fx.projectId}/releases`, { cookie: aliceJar })).status,
      200
    );
    assert.equal(
      (await api(fx.base, `/api/projects/${fx.projectId}/releases`, { cookie: bobJar })).status,
      403
    );
    assert.equal(
      (await api(fx.base, `/api/releases/${fx.releaseId}`, { cookie: aliceJar })).status,
      200
    );
    assert.equal(
      (await api(fx.base, `/api/releases/${fx.releaseId}`, { cookie: bobJar })).status,
      403
    );
    assert.equal(
      (await api(fx.base, `/api/projects/${fx.projectId}/metrics`, { cookie: aliceJar })).status,
      200
    );
    assert.equal(
      (await api(fx.base, `/api/projects/${fx.projectId}/metrics`, { cookie: bobJar })).status,
      403
    );
    assert.equal(
      (
        await api(fx.base, `/api/projects/${fx.projectId}/rollback`, {
          method: "POST",
          cookie: bobJar,
          body: { releaseId: fx.releaseId },
        })
      ).status,
      403
    );
    assert.equal(
      (await api(fx.base, `/api/projects/${fx.projectId}/github-link`, { cookie: bobJar }))
        .status,
      403
    );
    const link = (await api(fx.base, `/api/projects/${fx.projectId}/github-link`, {
      cookie: aliceJar,
    })) as { status: number; json: { linked: boolean } };
    assert.equal(link.status, 200);
    assert.equal(link.json.linked, false);
    assert.equal(
      (
        await api(fx.base, `/api/projects/${fx.projectId}/github-link`, {
          method: "DELETE",
          cookie: bobJar,
        })
      ).status,
      403
    );
  } finally {
    await teardown();
  }
});

test("health stays public and webhooks stay sessionless HMAC", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    assert.equal((await api(fx.base, "/api/health")).status, 200);
    const badSig = await fetch(`${fx.base}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Delivery": "e2e-delivery-1",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": "sha256=invalid",
      },
      body: JSON.stringify({ zen: "hi" }),
    });
    assert.equal(badSig.status, 401);
    await badSig.text().catch(() => "");
    const missing = await fetch(`${fx.base}/api/webhooks/github`, { method: "POST" });
    assert.equal(missing.status, 400);
    await missing.text().catch(() => "");
  } finally {
    await teardown();
  }
});

test("session cookie configuration follows the security model", async () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedOverride = process.env.DEPLOYKIT_COOKIE_SECURE;
  const savedDays = process.env.DEPLOYKIT_SESSION_DAYS;
  try {
    delete process.env.DEPLOYKIT_COOKIE_SECURE;
    process.env.NODE_ENV = "production";
    assert.equal(isCookieSecure(), true);
    process.env.NODE_ENV = "development";
    assert.equal(isCookieSecure(), false);
    process.env.DEPLOYKIT_COOKIE_SECURE = "true";
    assert.equal(isCookieSecure(), true);
    process.env.DEPLOYKIT_COOKIE_SECURE = "false";
    assert.equal(isCookieSecure(), false);
    process.env.DEPLOYKIT_COOKIE_SECURE = "maybe";
    assert.throws(() => isCookieSecure());
    delete process.env.DEPLOYKIT_SESSION_DAYS;
    assert.equal(getSessionLifetimeMs(), 7 * 24 * 3600 * 1000);
    process.env.DEPLOYKIT_SESSION_DAYS = "0";
    assert.throws(() => getSessionLifetimeMs());
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedOverride === undefined) delete process.env.DEPLOYKIT_COOKIE_SECURE;
    else process.env.DEPLOYKIT_COOKIE_SECURE = savedOverride;
    if (savedDays === undefined) delete process.env.DEPLOYKIT_SESSION_DAYS;
    else process.env.DEPLOYKIT_SESSION_DAYS = savedDays;
  }
});
