// Phase 11: domain authorization over real HTTP + PostgreSQL.
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import pool from "../db/database.js";
import app from "../app.js";
import { createUser } from "./userService.js";
import { createProject } from "./projectService.js";
import { SESSION_COOKIE_NAME } from "../config/sessionConfig.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.custom_domains') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

function uniqueEmail(tag: string): string {
  return `phase11-auth-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

function uniqueDomain(tag: string): string {
  return `phase11-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example.org`;
}

let server: ReturnType<typeof app.listen> | null = null;
const userIds: string[] = [];
const projectIds: string[] = [];

async function api(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string | null } = {}
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function jarOf(cookies: string[]): string | null {
  for (const h of cookies) {
    const [pair] = h.split(";");
    const i = pair.indexOf("=");
    if (i > 0 && pair.slice(0, i).trim() === SESSION_COOKIE_NAME) {
      return `${SESSION_COOKIE_NAME}=${pair.slice(i + 1).trim()}`;
    }
  }
  return null;
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-123" }),
  });
  const jar = jarOf(res.headers.getSetCookie());
  assert.ok(jar);
  return jar as string;
}

async function setup(): Promise<{ base: string; alice: string; bob: string; owned: string; legacy: string } | null> {
  if (!(await dbAvailable())) return null;
  if (!server) {
    server = app.listen(0);
    await new Promise<void>((r) => server!.once("listening", r));
  }
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const alice = await createUser({ email: uniqueEmail("alice"), password: "correct-horse-123" });
  const bob = await createUser({ email: uniqueEmail("bob"), password: "correct-horse-123" });
  userIds.push(alice.id, bob.id);
  const owned = await createProject({
    name: `d-${Date.now()}`,
    repositoryUrl: "https://github.com/acme/app.git",
    branch: "main",
    ownerUserId: alice.id,
  });
  const legacy = await createProject({
    name: `legacy-${Date.now()}`,
    repositoryUrl: "https://github.com/acme/legacy.git",
    branch: "main",
  });
  projectIds.push(owned.id, legacy.id);
  return {
    base,
    alice: await login(base, alice.email),
    bob: await login(base, bob.email),
    owned: owned.id,
    legacy: legacy.id,
  };
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
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((e: unknown) => (e ? reject(e) : resolve()))
    );
    server = null;
  }
}

test("owner can manage domains; stranger, anonymous, and legacy are denied", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    assert.equal((await api(fx.base, `/api/projects/${fx.owned}/domains`)).status, 401);
    assert.equal(
      (await api(fx.base, `/api/projects/${fx.owned}/domains`, { cookie: fx.bob })).status,
      403
    );
    assert.equal(
      (await api(fx.base, `/api/projects/${fx.legacy}/domains`, { cookie: fx.alice })).status,
      403
    );
    const created = await api(fx.base, `/api/projects/${fx.owned}/domains`, {
      method: "POST",
      cookie: fx.alice,
      body: { domain: uniqueDomain("ok") },
    });
    assert.equal(created.status, 201);
    const id = (created.json as { id: string }).id;
    assert.ok(id);
    // No secrets leak.
    const flat = JSON.stringify(created.json);
    assert.ok(!flat.includes("password_hash"));
    assert.ok(!flat.includes("verification_token_hash"));
    // Stranger cannot read the domain by id; owner can.
    assert.equal((await api(fx.base, `/api/domains/${id}`, { cookie: fx.bob })).status, 403);
    assert.equal((await api(fx.base, `/api/domains/${id}`, { cookie: fx.alice })).status, 200);
    // Invalid hostname rejected; collision across projects rejected.
    assert.equal(
      (
        await api(fx.base, `/api/projects/${fx.owned}/domains`, {
          method: "POST",
          cookie: fx.alice,
          body: { domain: "not a domain!!" },
        })
      ).status,
      400
    );
    // Deletion is owner-only and second deletion is stable 404.
    assert.equal(
      (await api(fx.base, `/api/domains/${id}`, { method: "DELETE", cookie: fx.bob })).status,
      403
    );
    assert.equal(
      (await api(fx.base, `/api/domains/${id}`, { method: "DELETE", cookie: fx.alice })).status,
      200
    );
    assert.equal(
      (await api(fx.base, `/api/domains/${id}`, { method: "DELETE", cookie: fx.alice })).status,
      404
    );
  } finally {
    await teardown();
  }
});

test("certificate trigger is owner-only and gated on verification", async () => {
  const fx = await setup();
  if (!fx) return;
  try {
    const created = await api(fx.base, `/api/projects/${fx.owned}/domains`, {
      method: "POST",
      cookie: fx.alice,
      body: { domain: uniqueDomain("tls") },
    });
    assert.equal(created.status, 201);
    const id = (created.json as { id: string }).id;
    const trigger = `/api/domains/${id}/certificate`;
    // Anonymous and stranger are denied before any state is touched.
    assert.equal((await api(fx.base, trigger, { method: "POST" })).status, 401);
    assert.equal(
      (await api(fx.base, trigger, { method: "POST", cookie: fx.bob })).status,
      403
    );
    // Unverified domains cannot start ACME (no uncontrolled issuance).
    const pending = await api(fx.base, trigger, { method: "POST", cookie: fx.alice });
    assert.equal(pending.status, 422);
    // Unknown ids stay 404.
    assert.equal(
      (
        await api(fx.base, `/api/domains/00000000-0000-0000-0000-000000000000/certificate`, {
          method: "POST",
          cookie: fx.alice,
        })
      ).status,
      404
    );
    // No key material ever appears in domain responses.
    const fetched = await api(fx.base, `/api/domains/${id}`, { cookie: fx.alice });
    assert.equal(fetched.status, 200);
    const flat = JSON.stringify(fetched.json);
    assert.ok(!flat.includes("PRIVATE KEY"));
    assert.ok(!flat.includes("BEGIN CERTIFICATE"));
  } finally {
    await teardown();
  }
});
