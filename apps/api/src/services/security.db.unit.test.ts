// Final Phase 10 security boundary: CORS, CSRF origin checks, PG-backed
// rate limiting, registration gating, and the session probe — over real HTTP
// against the Express app and real PostgreSQL. Extends (never duplicates)
// the Step 4 authentication/authorization coverage.
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import pool from "../db/database.js";
import app from "../app.js";
import { createUser } from "./userService.js";
import { createProject } from "./projectService.js";
import { getAllowedOrigins } from "../config/corsConfig.js";

const EVIL = "https://evil.example";
const DEV_ORIGIN = "http://localhost:5173";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.auth_rate_limits') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

// This file performs many localhost logins against the shared per-IP bucket,
// so raise the ceilings process-wide; individual tests tighten them.
const savedEnv: Record<string, string | undefined> = {};
for (const key of [
  "DEPLOYKIT_AUTH_RATE_LIMIT_WINDOW_SECONDS",
  "DEPLOYKIT_AUTH_RATE_LIMIT_MAX_ATTEMPTS",
  "DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS",
  "DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION",
]) {
  savedEnv[key] = process.env[key];
}
process.env.DEPLOYKIT_AUTH_RATE_LIMIT_WINDOW_SECONDS = "900";
process.env.DEPLOYKIT_AUTH_RATE_LIMIT_MAX_ATTEMPTS = "10000";
process.env.DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS = "1000";
delete process.env.DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION;

test.after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await cleanup();
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((e: unknown) => (e ? reject(e) : resolve()))
    );
    server = null;
  }
});

function uniqueEmail(tag: string): string {
  const rand = Math.floor(Math.random() * 1_000_000);
  return `phase10-sec-${tag}-${Date.now()}-${rand}@example.com`;
}

let server: ReturnType<typeof app.listen> | null = null;
let base = "";
const userIds: string[] = [];
const projectIds: string[] = [];

async function ensureServer(): Promise<string | null> {
  if (!(await dbAvailable())) return null;
  if (!server) {
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  return base;
}

interface ApiInit {
  method?: string;
  body?: unknown;
  cookie?: string | null;
  origin?: string | null;
  referer?: string | null;
}

async function api(
  path: string,
  init: ApiInit = {}
): Promise<{ status: number; json: unknown; headers: Headers; cookies: string[] }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.origin !== undefined && init.origin !== null) headers.Origin = init.origin;
  if (init.referer) headers.Referer = init.referer;
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return {
    status: res.status,
    json: await res.json().catch(() => ({})),
    headers: res.headers,
    cookies: res.headers.getSetCookie(),
  };
}

function sessionCookie(cookies: string[]): string | null {
  for (const header of cookies) {
    const [pair] = header.split(";");
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index).trim() === "deploykit_session") {
      return `deploykit_session=${pair.slice(index + 1).trim()}`;
    }
  }
  return null;
}

async function makeUser(tag: string, password = "correct-horse-123") {
  const user = await createUser({ email: uniqueEmail(tag), password });
  userIds.push(user.id);
  return user;
}

async function loginCookie(email: string, password = "correct-horse-123"): Promise<string> {
  const res = await api("/api/auth/login", { method: "POST", body: { email, password } });
  assert.equal(res.status, 200);
  const jar = sessionCookie(res.cookies);
  assert.ok(jar);
  return jar;
}

async function cleanup(): Promise<void> {
  if (projectIds.length > 0) {
    await pool.query(`DELETE FROM projects WHERE id = ANY($1)`, [projectIds]);
    projectIds.length = 0;
  }
  if (userIds.length > 0) {
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
    userIds.length = 0;
  }
  await pool.query(`DELETE FROM auth_rate_limits WHERE key LIKE 'login:%' OR key LIKE 'register:%'`);
}

// ---- CORS configuration ----

test("CORS config: dev defaults, explicit list, and fail-closed validation", () => {
  const savedOrigin = process.env.DEPLOYKIT_WEB_ORIGIN;
  const savedNode = process.env.NODE_ENV;
  try {
    delete process.env.DEPLOYKIT_WEB_ORIGIN;
    process.env.NODE_ENV = "development";
    assert.deepEqual(getAllowedOrigins(), ["http://localhost:5173", "http://localhost:8081"]);
    process.env.NODE_ENV = "production";
    assert.throws(() => getAllowedOrigins());
    process.env.NODE_ENV = "development";
    process.env.DEPLOYKIT_WEB_ORIGIN = "https://app.example.com, https://app.example.com/ ";
    assert.deepEqual(getAllowedOrigins(), ["https://app.example.com"]);
    for (const bad of ["*", "https://app.example.com, *", "not-a-url", "https://app.example.com/a/b"]) {
      process.env.DEPLOYKIT_WEB_ORIGIN = bad;
      assert.throws(() => getAllowedOrigins());
    }
  } finally {
    if (savedOrigin === undefined) delete process.env.DEPLOYKIT_WEB_ORIGIN;
    else process.env.DEPLOYKIT_WEB_ORIGIN = savedOrigin;
    if (savedNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNode;
  }
});

test("CORS headers: allowed origin reflected with credentials, others denied", async () => {
  if (!(await ensureServer())) return;
  try {
    const allowed = await api("/api/health", { origin: DEV_ORIGIN });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), DEV_ORIGIN);
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
    const denied = await api("/api/health", { origin: EVIL });
    assert.equal(denied.status, 200);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    const plain = await api("/api/health");
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get("access-control-allow-origin"), null);
  } finally {
    await cleanup();
  }
});

// ---- CSRF origin checks ----

test("unsafe browser requests from untrusted origins are rejected", async () => {
  if (!(await ensureServer())) return;
  const user = await makeUser("csrf");
  try {
    const jar = await loginCookie(user.email);
    // Evil origin is rejected even with a valid session.
    const evil = await api("/api/projects", {
      method: "POST",
      cookie: jar,
      origin: EVIL,
      body: { name: "x", repositoryUrl: "https://github.com/acme/x.git", branch: "main" },
    });
    assert.equal(evil.status, 403);
    assert.deepEqual(evil.json, { error: "Untrusted origin" });
    // Evil referer without origin is rejected too.
    const evilRef = await api("/api/projects", {
      method: "POST",
      cookie: jar,
      referer: `${EVIL}/dashboard`,
      body: { name: "x", repositoryUrl: "https://github.com/acme/x.git", branch: "main" },
    });
    assert.equal(evilRef.status, 403);
    // Allowlisted origin and referer pass the check (auth decides next).
    const okOrigin = await api("/api/projects", {
      method: "POST",
      cookie: jar,
      origin: DEV_ORIGIN,
      body: {
        name: `csrf-ok-${Date.now()}`,
        repositoryUrl: "https://github.com/acme/x.git",
        branch: "main",
      },
    });
    assert.equal(okOrigin.status, 201);
    projectIds.push((okOrigin.json as { id: string }).id);
    // Non-browser clients (no origin headers) are unaffected.
    const curlLike = await api("/api/projects", { cookie: jar });
    assert.equal(curlLike.status, 200);
    // Safe methods never trigger the check, even from evil origins.
    const safeGet = await api("/api/projects", { cookie: jar, origin: EVIL });
    assert.equal(safeGet.status, 200);
  } finally {
    await cleanup();
  }
});

test("login CSRF is blocked but the webhook HMAC path stays exempt", async () => {
  if (!(await ensureServer())) return;
  const user = await makeUser("csrf-login");
  try {
    const evilLogin = await api("/api/auth/login", {
      method: "POST",
      origin: EVIL,
      body: { email: user.email, password: "correct-horse-123" },
    });
    assert.equal(evilLogin.status, 403);
    const plainLogin = await api("/api/auth/login", {
      method: "POST",
      body: { email: user.email, password: "correct-horse-123" },
    });
    assert.equal(plainLogin.status, 200);
    // GitHub webhooks carry no browser origin and must never hit the
    // session/CSRF layer: bad signature is still a 401 from HMAC.
    const webhook = await fetch(`${base}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: EVIL,
        "X-GitHub-Delivery": "sec-1",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": "sha256=invalid",
      },
      body: JSON.stringify({ zen: "hi" }),
    });
    assert.equal(webhook.status, 401);
    await webhook.text().catch(() => "");
  } finally {
    await cleanup();
  }
});

// ---- Rate limiting ----

test("repeated failures are throttled without leaking account existence", async () => {
  if (!(await ensureServer())) return;
  process.env.DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS = "3";
  const email = uniqueEmail("throttle");
  const ghost = uniqueEmail("ghost");
  try {
    await makeUser("throttle-target").then(async (u) => {
      await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, u.id]);
    });
    for (let i = 0; i < 3; i++) {
      const res = await api("/api/auth/login", {
        method: "POST",
        body: { email, password: "wrong-password-xyz" },
      });
      assert.equal(res.status, 401);
    }
    const limited = await api("/api/auth/login", {
      method: "POST",
      body: { email, password: "wrong-password-xyz" },
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.json, { error: "Too many attempts" });
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    // Same response shape for an address that never existed.
    for (let i = 0; i < 3; i++) {
      await api("/api/auth/login", { method: "POST", body: { email: ghost, password: "x" } });
    }
    const ghostLimited = await api("/api/auth/login", {
      method: "POST",
      body: { email: ghost, password: "x" },
    });
    assert.equal(ghostLimited.status, 429);
    assert.deepEqual(ghostLimited.json, limited.json);
  } finally {
    delete process.env.DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS;
    process.env.DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS = "1000";
    await cleanup();
  }
});

test("successful login clears the account bucket; windows expire", async () => {
  if (!(await ensureServer())) return;
  process.env.DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS = "3";
  const user = await makeUser("reset");
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal(
        (await api("/api/auth/login", {
          method: "POST",
          body: { email: user.email, password: "wrong-password-xyz" },
        })).status,
        401
      );
    }
    assert.equal(
      (await api("/api/auth/login", {
        method: "POST",
        body: { email: user.email, password: "correct-horse-123" },
      })).status,
      200
    );
    // Two more failures stay under the cleared budget of 3.
    for (let i = 0; i < 2; i++) {
      assert.equal(
        (await api("/api/auth/login", {
          method: "POST",
          body: { email: user.email, password: "wrong-password-xyz" },
        })).status,
        401
      );
    }
    // One more exhausts it again.
    await api("/api/auth/login", {
      method: "POST",
      body: { email: user.email, password: "wrong-password-xyz" },
    });
    assert.equal(
      (await api("/api/auth/login", {
        method: "POST",
        body: { email: user.email, password: "wrong-password-xyz" },
      })).status,
      429
    );
    // Rewinding the window re-opens the budget (deterministic expiry).
    await pool.query(
      `UPDATE auth_rate_limits SET window_start = NOW() - INTERVAL '2 hours'
       WHERE key = $1`,
      [`login:email:${user.email}`]
    );
    assert.equal(
      (await api("/api/auth/login", {
        method: "POST",
        body: { email: user.email, password: "correct-horse-123" },
      })).status,
      200
    );
  } finally {
    process.env.DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS = "1000";
    await cleanup();
  }
});

test("limiter buckets are independent and increments are atomic", async () => {
  if (!(await ensureServer())) return;
  process.env.DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS = "1000";
  const first = uniqueEmail("iso-a");
  const second = uniqueEmail("iso-b");
  try {
    for (let i = 0; i < 5; i++) {
      await api("/api/auth/login", { method: "POST", body: { email: first, password: "x" } });
    }
    // A different address from the same IP is unaffected.
    assert.equal(
      (await api("/api/auth/login", { method: "POST", body: { email: second, password: "x" } }))
        .status,
      401
    );
    // Ten concurrent consumes on one fresh key all land exactly once each.
    const key = `login:email:${uniqueEmail("atomic")}`;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        pool.query(
          `INSERT INTO auth_rate_limits (key, window_start, count)
           VALUES ($1, NOW(), 1)
           ON CONFLICT (key) DO UPDATE SET count = auth_rate_limits.count + 1`,
          [key]
        )
      )
    );
    const count = (
      await pool.query(`SELECT count FROM auth_rate_limits WHERE key = $1`, [key])
    ).rows[0].count;
    assert.equal(count, 10);
    await pool.query(`DELETE FROM auth_rate_limits WHERE key = $1`, [key]);
  } finally {
    process.env.DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS = "1000";
    await cleanup();
  }
});

// ---- Registration ----

test("registration creates an account without a session when open", async () => {
  if (!(await ensureServer())) return;
  process.env.DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION = "true";
  const email = uniqueEmail("reg");
  try {
    const res = await api("/api/auth/register", {
      method: "POST",
      body: { email, password: "correct-horse-123" },
    });
    assert.equal(res.status, 201);
    const body = res.json as Record<string, unknown>;
    assert.equal(body.email, email);
    assert.ok(!("password_hash" in body));
    assert.equal(sessionCookie(res.cookies), null);
    const row = (await pool.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0];
    userIds.push(row.id);
    // Duplicate email is a safe 409, not a 500 or a second account.
    const dup = await api("/api/auth/register", {
      method: "POST",
      body: { email, password: "correct-horse-123" },
    });
    assert.equal(dup.status, 409);
    // Policy violations stay 400.
    assert.equal(
      (await api("/api/auth/register", { method: "POST", body: { email: uniqueEmail("w"), password: "short" } }))
        .status,
      400
    );
    assert.equal(
      (await api("/api/auth/register", { method: "POST", body: { email: "nope", password: "correct-horse-123" } }))
        .status,
      400
    );
  } finally {
    delete process.env.DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION;
    await cleanup();
  }
});

test("registration closes once accounts exist unless explicitly enabled", async () => {
  if (!(await ensureServer())) return;
  delete process.env.DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION;
  try {
    const usersBefore = (await pool.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n;
    if (usersBefore === 0) {
      // First-user bootstrap window: open while the table is empty.
      const email = uniqueEmail("bootstrap");
      const res = await api("/api/auth/register", {
        method: "POST",
        body: { email, password: "correct-horse-123" },
      });
      assert.equal(res.status, 201);
      userIds.push((res.json as { id: string }).id);
    }
    // With accounts present and no flag, the door stays shut.
    const closed = await api("/api/auth/register", {
      method: "POST",
      body: { email: uniqueEmail("shut"), password: "correct-horse-123" },
    });
    assert.equal(closed.status, 403);
    assert.deepEqual(closed.json, { error: "Public registration is disabled" });
  } finally {
    await cleanup();
  }
});

// ---- Session probe + remaining route coverage ----

test("session probe returns the user on a valid cookie and 401 otherwise", async () => {
  if (!(await ensureServer())) return;
  const user = await makeUser("probe");
  try {
    const jar = await loginCookie(user.email);
    const ok = await api("/api/auth/session", { cookie: jar });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, {
      user: {
        id: user.id,
        email: user.email,
        created_at: (ok.json as { user: { created_at: string } }).user.created_at,
        updated_at: (ok.json as { user: { updated_at: string } }).user.updated_at,
      },
    });
    assert.equal((await api("/api/auth/session")).status, 401);
    assert.equal((await api("/api/auth/session", { cookie: "deploykit_session=bogus" })).status, 401);
  } finally {
    await cleanup();
  }
});

test("forwarded clients behind the proxy get independent buckets; spoofed prefixes ignored", async () => {
  if (!(await ensureServer())) return;
  process.env.DEPLOYKIT_AUTH_RATE_LIMIT_MAX_ATTEMPTS = "2";
  process.env.DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS = "1000";
  const emailA = uniqueEmail("xff-a");
  const emailB = uniqueEmail("xff-b");
  try {
    const post = (email: string, xff?: string) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (xff !== undefined) headers["X-Forwarded-For"] = xff;
      return fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, password: "wrong-password-xyz" }),
      }).then(async (res) => res.status);
    };
    assert.equal(await post(emailA, "198.51.100.11"), 401);
    assert.equal(await post(emailA, "198.51.100.11"), 401);
    assert.equal(await post(emailA, "198.51.100.11"), 429);
    // A different forwarded client is unaffected by A's exhaustion.
    assert.equal(await post(emailB, "198.51.100.22"), 401);
    // Attacker-injected prefix is ignored: the proxy-appended last entry keys the bucket.
    assert.equal(await post(uniqueEmail("xff-c"), "9.9.9.9, 198.51.100.33"), 401);
    const keyed = await pool.query(`SELECT key FROM auth_rate_limits WHERE key = $1`, [
      "login:ip:198.51.100.33",
    ]);
    assert.equal(keyed.rowCount, 1);
    assert.equal(
      (await pool.query(`SELECT COUNT(*)::int AS n FROM auth_rate_limits WHERE key = $1`, [
        "login:ip:9.9.9.9",
      ])).rows[0].n,
      0
    );
  } finally {
    process.env.DEPLOYKIT_AUTH_RATE_LIMIT_MAX_ATTEMPTS = "10000";
    process.env.DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS = "1000";
    await cleanup();
  }
});

test("strangers cannot create deployments, delete projects, or touch github links", async () => {  if (!(await ensureServer())) return;
  const owner = await makeUser("own-x");
  const stranger = await makeUser("str-x");
  try {
    const project = await createProject({
      name: `x-${Date.now()}`,
      repositoryUrl: "https://github.com/acme/x.git",
      branch: "main",
      ownerUserId: owner.id,
    });
    projectIds.push(project.id);
    const ownerJar = await loginCookie(owner.email);
    const strangerJar = await loginCookie(stranger.email);
    assert.equal(
      (
        await api(`/api/projects/${project.id}/deployments`, {
          method: "POST",
          cookie: strangerJar,
          body: { trigger: "manual" },
        })
      ).status,
      403
    );
    assert.equal(
      (await api(`/api/projects/${project.id}`, { method: "DELETE", cookie: strangerJar })).status,
      403
    );
    assert.equal(
      (
        await api(`/api/projects/${project.id}/github-link`, {
          method: "POST",
          cookie: strangerJar,
          body: { installationId: "1", repositoryFullName: "acme/x" },
        })
      ).status,
      403
    );
    assert.equal(
      (await api(`/api/projects/${project.id}`, { method: "DELETE" })).status,
      401
    );
    // Owner paths still work end to end.
    assert.equal((await api(`/api/projects/${project.id}`, { cookie: ownerJar })).status, 200);
  } finally {
    await cleanup();
  }
});
