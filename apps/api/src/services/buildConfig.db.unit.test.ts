// Phase 02 Stage 2A: build configuration persistence, project-scoped
// authorization, explicit-vs-detected precedence, and detection orchestration.
// Requires PostgreSQL with migration 020 applied.

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import app from "../app.js";
import pool from "../db/database.js";
import { createUser } from "./userService.js";
import { createProject } from "./projectService.js";
import {
  BuildConfigError,
  clearProjectBuildConfig,
  getProjectBuildConfig,
  saveProjectBuildConfig,
  type BuildConfig,
} from "./buildConfigService.js";
import {
  detectProjectById,
  runDetectionInWorkspace,
} from "./projectDetectionService.js";
import { withCheckedOutRepository } from "../infrastructure/git/sourceCheckout.js";
import { gateDb } from "../test/dbGate.js";

const SUITE = "services/buildConfig.db.unit.test.ts";
const SHARED_DATABASE = "deploykit";

async function currentDatabase(): Promise<string> {
  const result = await pool.query(`SELECT current_database() AS name`);
  return String(result.rows[0]?.name ?? "");
}

async function dbAvailable(): Promise<boolean> {
  try {
    if (!process.env.DATABASE_URL) return false;
    if ((await currentDatabase()) === SHARED_DATABASE) return false;
    const table = await pool.query(`SELECT to_regclass('public.projects') AS c`);
    if (table.rows[0].c === null) return false;
    const column = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'projects'
          AND column_name = 'build_config'`
    );
    return column.rowCount === 1;
  } catch {
    return false;
  }
}

const savedEnv: Record<string, string | undefined> = {};
for (const key of [
  "DEPLOYKIT_AUTH_RATE_LIMIT_WINDOW_SECONDS",
  "DEPLOYKIT_AUTH_RATE_LIMIT_MAX_ATTEMPTS",
  "DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS",
]) {
  savedEnv[key] = process.env[key];
}
process.env.DEPLOYKIT_AUTH_RATE_LIMIT_WINDOW_SECONDS = "900";
process.env.DEPLOYKIT_AUTH_RATE_LIMIT_MAX_ATTEMPTS = "10000";
process.env.DEPLOYKIT_AUTH_RATE_LIMIT_EMAIL_MAX_ATTEMPTS = "1000";

let server: ReturnType<typeof app.listen> | null = null;
let base = "";
const userIds: string[] = [];
const projectIds: string[] = [];

async function ensureServer(): Promise<string | null> {
  if (!(await gateDb(SUITE, dbAvailable))) return null;
  if (!server) {
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  return base;
}

function uniqueEmail(tag: string): string {
  const rand = Math.floor(Math.random() * 1_000_000);
  return `phase02a-${tag}-${Date.now()}-${rand}@example.com`;
}

async function makeUser(tag: string) {
  const user = await createUser({ email: uniqueEmail(tag), password: "correct-horse-123" });
  userIds.push(user.id);
  return user;
}

interface ApiInit {
  method?: string;
  body?: unknown;
  cookie?: string | null;
}

async function api(
  requestPath: string,
  init: ApiInit = {}
): Promise<{ status: number; json: unknown; cookies: string[] }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(`${base}${requestPath}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return {
    status: res.status,
    json: await res.json().catch(() => ({})),
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

async function loginCookie(email: string): Promise<string> {
  const res = await api("/api/auth/login", {
    method: "POST",
    body: { email, password: "correct-horse-123" },
  });
  assert.equal(res.status, 200);
  const jar = sessionCookie(res.cookies);
  assert.ok(jar);
  return jar;
}

async function makeProject(name: string, ownerUserId: string) {
  const project = await createProject({
    name,
    repositoryUrl: "https://github.com/acme/app.git",
    branch: "main",
    ownerUserId,
  });
  projectIds.push(project.id);
  return project;
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
  await pool.query(
    `DELETE FROM auth_rate_limits WHERE key LIKE 'login:%' OR key LIKE 'register:%'`
  ).catch(() => undefined);
}

test.after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await cleanup();
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error: unknown) => (error ? reject(error) : resolve()))
    );
    server = null;
  }
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "build-config-db-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const explicitNode: BuildConfig = {
  applicationRoot: ".",
  builder: "node",
  dockerfilePath: null,
  buildCommand: "npm run build:prod",
  startCommand: "npm start",
  outputDirectory: "build",
};

// --- Isolation --------------------------------------------------------------

test("database is isolated from the shared deploykit database", async () => {
  if (!process.env.DATABASE_URL) return;
  const name = await currentDatabase().catch(() => null);
  if (name === null) return;
  assert.notEqual(
    name,
    SHARED_DATABASE,
    "refusing to run against the shared deploykit database"
  );
});

// --- Schema -----------------------------------------------------------------

test("build_config column is nullable JSONB with an object guard", async () => {
  if (!(await gateDb(SUITE, dbAvailable))) return;
  const column = (
    await pool.query(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'projects'
          AND column_name = 'build_config'`
    )
  ).rows[0];
  assert.equal(column.data_type, "jsonb");
  assert.equal(column.is_nullable, "YES");

  const constraint = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'projects_build_config_object'`
  );
  assert.equal(constraint.rowCount, 1);
});

// --- Service persistence ----------------------------------------------------

test("explicit config persists, reads back, and clears", async () => {
  if (!(await gateDb(SUITE, dbAvailable))) return;
  const owner = await makeUser("persist");
  const project = await makeProject(`persist-${Date.now()}`, owner.id);
  try {
    assert.equal(await getProjectBuildConfig(project.id), null);
    const saved = await saveProjectBuildConfig(project.id, explicitNode);
    assert.deepEqual(saved.config, explicitNode);
    assert.ok(saved.updatedAt);

    const readBack = await getProjectBuildConfig(project.id);
    assert.deepEqual(readBack?.config, explicitNode);

    await clearProjectBuildConfig(project.id);
    assert.equal(await getProjectBuildConfig(project.id), null);
  } finally {
    await cleanup();
  }
});

test("invalid config is rejected before touching the database", async () => {
  if (!(await gateDb(SUITE, dbAvailable))) return;
  const owner = await makeUser("invalid");
  const project = await makeProject(`invalid-${Date.now()}`, owner.id);
  try {
    await assert.rejects(
      saveProjectBuildConfig(project.id, { builder: "node", applicationRoot: "/etc" }),
      (error: unknown) => error instanceof BuildConfigError && error.code === "INVALID_CONFIG"
    );
    assert.equal(await getProjectBuildConfig(project.id), null);
  } finally {
    await cleanup();
  }
});

// --- Authorization ----------------------------------------------------------

test("anonymous access is rejected on every configuration endpoint", async () => {
  const url = await ensureServer();
  if (!url) return;
  const owner = await makeUser("anon");
  const project = await makeProject(`anon-${Date.now()}`, owner.id);
  try {
    assert.equal((await api(`/api/projects/${project.id}/build-config`)).status, 401);
    assert.equal(
      (await api(`/api/projects/${project.id}/build-config`, { method: "PUT", body: explicitNode }))
        .status,
      401
    );
    assert.equal(
      (await api(`/api/projects/${project.id}/build-config`, { method: "DELETE" })).status,
      401
    );
    assert.equal((await api(`/api/projects/${project.id}/detect`, { method: "POST" })).status, 401);
  } finally {
    await cleanup();
  }
});

test("another user's project is not exposed", async () => {
  const url = await ensureServer();
  if (!url) return;
  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const project = await makeProject(`private-${Date.now()}`, owner.id);
  try {
    const strangerJar = await loginCookie(stranger.email);
    assert.equal(
      (await api(`/api/projects/${project.id}/build-config`, { cookie: strangerJar })).status,
      403
    );
    assert.equal(
      (
        await api(`/api/projects/${project.id}/build-config`, {
          method: "PUT",
          cookie: strangerJar,
          body: explicitNode,
        })
      ).status,
      403
    );
    assert.equal(
      (await api(`/api/projects/${project.id}/build-config`, { method: "DELETE", cookie: strangerJar }))
        .status,
      403
    );
    assert.equal(
      (await api(`/api/projects/${project.id}/detect`, { method: "POST", cookie: strangerJar }))
        .status,
      403
    );
    // Nothing was written by the stranger's attempts.
    assert.equal(await getProjectBuildConfig(project.id), null);
  } finally {
    await cleanup();
  }
});

test("invalid project id is rejected before any lookup", async () => {
  const url = await ensureServer();
  if (!url) return;
  const owner = await makeUser("badid");
  const jar = await loginCookie(owner.email);
  try {
    assert.equal((await api(`/api/projects/not-a-uuid/build-config`, { cookie: jar })).status, 400);
    assert.equal(
      (await api(`/api/projects/not-a-uuid/detect`, { method: "POST", cookie: jar })).status,
      400
    );
  } finally {
    await cleanup();
  }
});

// --- HTTP happy path and validation ----------------------------------------

test("owner can save, read, and clear configuration over HTTP", async () => {
  const url = await ensureServer();
  if (!url) return;
  const owner = await makeUser("crud");
  const project = await makeProject(`crud-${Date.now()}`, owner.id);
  try {
    const jar = await loginCookie(owner.email);

    const initial = await api(`/api/projects/${project.id}/build-config`, { cookie: jar });
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.json, { config: null, updatedAt: null });

    const put = await api(`/api/projects/${project.id}/build-config`, {
      method: "PUT",
      cookie: jar,
      body: explicitNode,
    });
    assert.equal(put.status, 200);
    assert.deepEqual((put.json as { config: unknown }).config, explicitNode);

    const read = await api(`/api/projects/${project.id}/build-config`, { cookie: jar });
    assert.equal(read.status, 200);
    assert.deepEqual((read.json as { config: unknown }).config, explicitNode);

    const del = await api(`/api/projects/${project.id}/build-config`, {
      method: "DELETE",
      cookie: jar,
    });
    assert.equal(del.status, 200);
    assert.deepEqual(del.json, { config: null });

    const after = await api(`/api/projects/${project.id}/build-config`, { cookie: jar });
    assert.deepEqual(after.json, { config: null, updatedAt: null });
  } finally {
    await cleanup();
  }
});

test("invalid HTTP configuration returns 400 and does not persist", async () => {
  const url = await ensureServer();
  if (!url) return;
  const owner = await makeUser("badcfg");
  const project = await makeProject(`badcfg-${Date.now()}`, owner.id);
  try {
    const jar = await loginCookie(owner.email);
    const absolute = await api(`/api/projects/${project.id}/build-config`, {
      method: "PUT",
      cookie: jar,
      body: { builder: "node", applicationRoot: "/etc" },
    });
    assert.equal(absolute.status, 400);

    const unknownKey = await api(`/api/projects/${project.id}/build-config`, {
      method: "PUT",
      cookie: jar,
      body: { builder: "node", runCommand: "sh -c whoami" },
    });
    assert.equal(unknownKey.status, 400);

    const missingDockerfile = await api(`/api/projects/${project.id}/build-config`, {
      method: "PUT",
      cookie: jar,
      body: { builder: "dockerfile" },
    });
    assert.equal(missingDockerfile.status, 400);

    assert.equal(await getProjectBuildConfig(project.id), null);
  } finally {
    await cleanup();
  }
});

// --- Precedence and re-detection -------------------------------------------

test("re-detection never overwrites explicit configuration", async () => {
  if (!(await gateDb(SUITE, dbAvailable))) return;
  const owner = await makeUser("precedence");
  const project = await makeProject(`precedence-${Date.now()}`, owner.id);
  try {
    await saveProjectBuildConfig(project.id, explicitNode);
    const detectionRoot = workspace({
      "package.json": JSON.stringify({
        name: "app",
        scripts: { build: "vite build" },
        devDependencies: { vite: "^5.0.0" },
      }),
    });

    const fakeWithWorkspace = (async (_options, work) =>
      work({ workspace: detectionRoot, commitSha: "a".repeat(40) })) as typeof withCheckedOutRepository;

    const response = await detectProjectById(project.id, {
      loadProject: async (id) => ({
        id,
        repository_url: "https://github.com/acme/app.git",
        branch: "main",
      }),
      resolveToken: async () => undefined,
      withWorkspace: fakeWithWorkspace,
      loadExplicitConfig: async () => (await getProjectBuildConfig(project.id))?.config ?? null,
    });

    assert.equal(response.status, "detected");
    assert.equal(response.detected?.config.buildCommand, "vite build");
    // Explicit values win in the effective view:
    assert.equal(response.effective?.buildCommand, "npm run build:prod");
    assert.equal(response.effective?.sources.buildCommand, "explicit");
    // The persisted explicit configuration is byte-for-byte unchanged:
    assert.deepEqual((await getProjectBuildConfig(project.id))?.config, explicitNode);
  } finally {
    await cleanup();
  }
});

test("detection reports ambiguous monorepos without selecting a root", async () => {
  if (!(await gateDb(SUITE, dbAvailable))) return;
  const owner = await makeUser("monorepo");
  const project = await makeProject(`monorepo-${Date.now()}`, owner.id);
  try {
    const detectionRoot = workspace({
      "package.json": JSON.stringify({ name: "root" }),
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "packages/api/package.json": JSON.stringify({ name: "api" }),
    });
    const fakeWithWorkspace = (async (_options, work) =>
      work({ workspace: detectionRoot, commitSha: "b".repeat(40) })) as typeof withCheckedOutRepository;

    const response = await detectProjectById(project.id, {
      loadProject: async (id) => ({
        id,
        repository_url: "https://github.com/acme/app.git",
        branch: "main",
      }),
      resolveToken: async () => undefined,
      withWorkspace: fakeWithWorkspace,
      loadExplicitConfig: async () => null,
    });

    assert.equal(response.status, "ambiguous");
    assert.equal(response.detected, null);
    assert.deepEqual(response.ambiguous?.candidates, ["apps/web", "packages/api"]);
    assert.equal(await getProjectBuildConfig(project.id), null);
  } finally {
    await cleanup();
  }
});

test("detection failure leaves explicit configuration intact", async () => {
  if (!(await gateDb(SUITE, dbAvailable))) return;
  const owner = await makeUser("failure");
  const project = await makeProject(`failure-${Date.now()}`, owner.id);
  try {
    await saveProjectBuildConfig(project.id, explicitNode);
    let attempts = 0;
    const failingWithWorkspace = (async () => {
      attempts += 1;
      throw new Error("simulated checkout failure");
    }) as typeof withCheckedOutRepository;

    await assert.rejects(
      detectProjectById(project.id, {
        loadProject: async (id) => ({
          id,
          repository_url: "https://github.com/acme/app.git",
          branch: "main",
        }),
        resolveToken: async () => undefined,
        withWorkspace: failingWithWorkspace,
        loadExplicitConfig: async () => (await getProjectBuildConfig(project.id))?.config ?? null,
      }),
      /simulated checkout failure/
    );
    assert.equal(attempts, 1);
    assert.deepEqual((await getProjectBuildConfig(project.id))?.config, explicitNode);
  } finally {
    await cleanup();
  }
});

test("pure detection helper reports explicit issues without mutation", async () => {
  if (!(await gateDb(SUITE, dbAvailable))) return;
  const root = workspace({
    "package.json": JSON.stringify({ name: "app" }),
  });
  const explicit: BuildConfig = {
    applicationRoot: "does-not-exist",
    builder: "node",
    dockerfilePath: null,
    buildCommand: null,
    startCommand: null,
    outputDirectory: null,
  };
  const response = runDetectionInWorkspace(root, "c".repeat(40), explicit);
  assert.deepEqual(response.explicit, explicit);
  assert.ok(response.explicitIssues.length > 0);
});
