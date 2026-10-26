import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import pool from "../db/database.js";
import app from "../app.js";
import { createUser } from "./userService.js";
import { createProject } from "./projectService.js";
import { persistCandidate } from "./incidentService.js";
import { SESSION_COOKIE_NAME } from "../config/sessionConfig.js";
import { gateDb } from "../test/dbGate.js";

const SUITE = "services/incidentApi.db.unit.test.ts";

let server: ReturnType<typeof app.listen> | null = null;
const userIds: string[] = [];
const projectIds: string[] = [];
let fixture: {
  base: string;
  alice: string;
  bob: string;
  aliceCookie: string;
  bobCookie: string;
  projectId: string;
  otherProjectId: string;
  incidentId: string;
} | null = null;

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    const check = await pool.query(
      `SELECT to_regclass('public.incidents') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

function uniqueEmail(tag: string): string {
  const rand = Math.floor(Math.random() * 1_000_000);
  return `phase3-inc-${tag}-${Date.now()}-${rand}@example.com`;
}

async function api(
  base: string,
  path: string,
  init: { method?: string; cookie?: string | null; origin?: string } = {}
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.origin) headers.Origin = init.origin;
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
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

async function login(
  base: string,
  email: string,
  password: string
): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = sessionCookie(res.headers.getSetCookie());
  assert.ok(cookie, "login must yield a session cookie");
  return cookie;
}

async function setup(): Promise<typeof fixture> {
  if (!(await gateDb(SUITE, dbAvailable))) return null;
  if (fixture) return fixture;
  if (!server) {
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
  }
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const alice = await createUser({
    email: uniqueEmail("alice"),
    password: "correct-horse-123",
  });
  const bob = await createUser({
    email: uniqueEmail("bob"),
    password: "correct-horse-123",
  });
  userIds.push(alice.id, bob.id);

  const project = await createProject({
    name: `inc-owned-${Date.now()}`,
    repositoryUrl: "https://github.com/acme/app.git",
    branch: "main",
    ownerUserId: alice.id,
  });
  const other = await createProject({
    name: `inc-other-${Date.now()}`,
    repositoryUrl: "https://github.com/acme/other.git",
    branch: "main",
    ownerUserId: alice.id,
  });
  projectIds.push(project.id, other.id);

  const created = await persistCandidate({
    projectId: project.id,
    kind: "deployment_failure",
    subjectKey: `deployment:api-${Date.now()}`,
    severity: "warning",
    title: "Deployment failed on main",
    detail: "build failed during api test",
    errorCode: "BUILD_FAILED",
    evidence: { branch: "main" },
    signalToken: `failed:api-${Date.now()}`,
    sourceTimestamp: new Date(),
  });
  assert.equal(created.outcome, "created");

  fixture = {
    base,
    alice: alice.id,
    bob: bob.id,
    aliceCookie: await login(base, alice.email, "correct-horse-123"),
    bobCookie: await login(base, bob.email, "correct-horse-123"),
    projectId: project.id,
    otherProjectId: other.id,
    incidentId: (created as { incident: { id: string } }).incident.id,
  };
  return fixture;
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
  await pool.query(
    `DELETE FROM auth_rate_limits WHERE key LIKE 'login:%' OR key LIKE 'register:%'`
  ).catch(() => undefined);
  fixture = null;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
}

test("incident routes require authentication", async () => {
  const f = await setup();
  if (!f) return;
  const paths = [
    `/api/projects/${f.projectId}/incidents`,
    `/api/projects/${f.projectId}/incidents/${f.incidentId}`,
  ];
  for (const path of paths) {
    const res = await api(f.base, path);
    assert.equal(res.status, 401, `GET ${path} requires a session`);
  }
  const ack = await api(
    f.base,
    `/api/projects/${f.projectId}/incidents/${f.incidentId}/acknowledge`,
    { method: "POST" }
  );
  assert.equal(ack.status, 401, "acknowledge requires a session");
  const resolve = await api(
    f.base,
    `/api/projects/${f.projectId}/incidents/${f.incidentId}/resolve`,
    { method: "POST" }
  );
  assert.equal(resolve.status, 401, "resolve requires a session");
});

test("a non-member is refused access to another project's incidents", async () => {
  const f = await setup();
  if (!f) return;
  const res = await api(
    f.base,
    `/api/projects/${f.projectId}/incidents`,
    { cookie: f.bobCookie }
  );
  assert.equal(res.status, 403);
});

test("list returns the project's incidents for its member", async () => {
  const f = await setup();
  if (!f) return;
  const res = await api(f.base, `/api/projects/${f.projectId}/incidents`, {
    cookie: f.aliceCookie,
  });
  assert.equal(res.status, 200);
  const rows = res.json as Array<{ id: string; project_id: string }>;
  assert.ok(Array.isArray(rows));
  assert.ok(rows.some((r) => r.id === f.incidentId));
  assert.ok(rows.every((r) => r.project_id === f.projectId));
});

test("list validation rejects unknown kinds and clamps the limit", async () => {
  const f = await setup();
  if (!f) return;
  const bad = await api(
    f.base,
    `/api/projects/${f.projectId}/incidents?kind=nonsense`,
    { cookie: f.aliceCookie }
  );
  assert.equal(bad.status, 400);

  const ok = await api(
    f.base,
    `/api/projects/${f.projectId}/incidents?limit=1000`,
    { cookie: f.aliceCookie }
  );
  assert.equal(ok.status, 200, "an oversized limit clamps instead of failing");
  assert.ok((ok.json as unknown[]).length <= 100);
});

test("detail returns 400 for malformed ids and 404 for foreign ids", async () => {
  const f = await setup();
  if (!f) return;
  const malformed = await api(
    f.base,
    `/api/projects/${f.projectId}/incidents/not-a-uuid`,
    { cookie: f.aliceCookie }
  );
  assert.equal(malformed.status, 400);

  const unknown = await api(
    f.base,
    `/api/projects/${f.projectId}/incidents/00000000-0000-4000-8000-000000000099`,
    { cookie: f.aliceCookie }
  );
  assert.equal(unknown.status, 404);

  // The incident exists but belongs to another project: never a leak.
  const crossProject = await api(
    f.base,
    `/api/projects/${f.otherProjectId}/incidents/${f.incidentId}`,
    { cookie: f.aliceCookie }
  );
  assert.equal(crossProject.status, 404);
});

test("acknowledge and resolve follow the guarded state machine with 409s", async () => {
  const f = await setup();
  if (!f) return;
  const url = `/api/projects/${f.projectId}/incidents/${f.incidentId}`;
  // Must be an allowed origin (dev defaults: 5173/8081), or the CSRF guard 403s.
  const origin = "http://localhost:8081";

  const ack = await api(f.base, `${url}/acknowledge`, {
    method: "POST",
    cookie: f.aliceCookie,
    origin,
  });
  assert.equal(ack.status, 200);
  assert.equal((ack.json as { status: string }).status, "acknowledged");

  const ackAgain = await api(f.base, `${url}/acknowledge`, {
    method: "POST",
    cookie: f.aliceCookie,
    origin,
  });
  assert.equal(ackAgain.status, 409, "double acknowledge is a conflict");

  const resolve = await api(f.base, `${url}/resolve`, {
    method: "POST",
    cookie: f.aliceCookie,
    origin,
  });
  assert.equal(resolve.status, 200);
  assert.equal((resolve.json as { status: string }).status, "resolved");
  assert.equal((resolve.json as { resolution: string }).resolution, "manual");

  const resolveAgain = await api(f.base, `${url}/resolve`, {
    method: "POST",
    cookie: f.aliceCookie,
    origin,
  });
  assert.equal(resolveAgain.status, 409, "double resolve is a conflict");

  const ackAfterResolve = await api(f.base, `${url}/acknowledge`, {
    method: "POST",
    cookie: f.aliceCookie,
    origin,
  });
  assert.equal(ackAfterResolve.status, 409, "ack after resolve is a conflict");

  const badId = await api(
    f.base,
    `/api/projects/${f.projectId}/incidents/not-a-uuid/resolve`,
    { method: "POST", cookie: f.aliceCookie, origin }
  );
  assert.equal(badId.status, 400, "malformed ids are rejected");
});

test("untrusted origins are refused on incident transitions", async () => {
  const f = await setup();
  if (!f) return;
  const res = await api(
    f.base,
    `/api/projects/${f.projectId}/incidents/${f.incidentId}/resolve`,
    { method: "POST", cookie: f.aliceCookie, origin: "https://evil.example" }
  );
  assert.equal(res.status, 403);
});

test("teardown", async () => {
  await teardown();
  assert.ok(true);
});
