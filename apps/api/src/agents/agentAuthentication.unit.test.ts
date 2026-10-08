import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";

import pool from "../db/database.js";
import {
  createAgent,
  createEnrollmentCredential,
  revokeAgent,
  revokeCredential,
} from "./agentService.js";
import {
  authenticateAgentToken,
  parseBearerToken,
} from "./agentAuthentication.js";
import {
  authenticateAgent,
  createAgentAuthMiddleware,
} from "../middleware/agentAuth.js";
import {
  getAgentMeController,
  postAgentHeartbeatController,
} from "../controllers/agentController.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.agents') AS agents,
              to_regclass('public.agent_credentials') AS creds`
    );
    return check.rows[0].agents !== null && check.rows[0].creds !== null;
  } catch {
    return false;
  }
}

function uniqueName(tag: string): string {
  const rand = Math.floor(Math.random() * 1_000_000);
  return `edge122-${tag}-${Date.now()}-${rand}`;
}

async function makeProject(name: string): Promise<{ id: string }> {
  const row = (
    await pool.query(
      `INSERT INTO projects (name, repository_url, branch)
       VALUES ($1, 'https://github.com/acme/app.git', 'main')
       RETURNING id`,
      [name]
    )
  ).rows[0] as { id: string };
  return row;
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  res: Response;
}

function fakeRes(): FakeRes {
  const fake = {
    statusCode: 200,
    body: undefined as unknown,
    res: undefined as unknown as Response,
  };
  const res = {
    status(code: number) {
      fake.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      fake.body = payload;
      return res;
    },
  };
  fake.res = res as unknown as Response;
  return fake;
}

function fakeReq(init: {
  headers?: Record<string, string | undefined>;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
  agent?: { agentId: string; projectId: string; credentialId: string };
}): Request {
  return {
    headers: init.headers ?? {},
    body: init.body,
    params: init.params ?? {},
    query: init.query ?? {},
    ...(init.agent === undefined ? {} : { agent: init.agent }),
  } as unknown as Request;
}

function nextCounter(): { next: NextFunction; calls: () => number } {
  let calls = 0;
  const next: NextFunction = () => {
    calls += 1;
  };
  return { next, calls: () => calls };
}

test("missing Authorization header yields no token", async () => {
  assert.equal(parseBearerToken(undefined), null);
  assert.equal(parseBearerToken(null), null);
  assert.equal(parseBearerToken(123), null);
  assert.equal(
    await authenticateAgentToken(undefined, async () => {
      throw new Error("resolver must not run without a token");
    }),
    null
  );
});

test("malformed Authorization headers are rejected", async () => {
  assert.equal(parseBearerToken(""), null);
  assert.equal(parseBearerToken("Bearer"), null);
  assert.equal(parseBearerToken("Bearer  abc def"), null);
  assert.equal(parseBearerToken("Bearer\tabc"), null);
  assert.equal(
    await authenticateAgentToken("Bearer", async () => ({
      credentialId: "c",
      agentId: "a",
      projectId: "p",
    })),
    null
  );
});

test("non-Bearer schemes are rejected", async () => {
  assert.equal(parseBearerToken("Basic abc123"), null);
  assert.equal(parseBearerToken("bearer abc123"), null);
  assert.equal(parseBearerToken("Token abc123"), null);
  assert.equal(parseBearerToken("BEARER abc123"), null);
});

test("empty bearer tokens are rejected", async () => {
  assert.equal(parseBearerToken("Bearer "), null);
  assert.equal(parseBearerToken("Bearer    "), null);
  assert.equal(await authenticateAgentToken("Bearer ", async () => null), null);
});

test("well-formed Bearer tokens are extracted verbatim", async () => {
  assert.equal(parseBearerToken("Bearer abc123"), "abc123");
  assert.equal(parseBearerToken(`Bearer ${"a".repeat(64)}`), "a".repeat(64));
});

test("a resolved credential yields exactly the safe identity", async () => {
  const context = await authenticateAgentToken("Bearer tok", async () => ({
    credentialId: "cred-1",
    agentId: "agent-1",
    projectId: "project-1",
  }));
  assert.deepEqual(context, {
    agentId: "agent-1",
    projectId: "project-1",
    credentialId: "cred-1",
  });
  assert.ok(!("token" in (context as unknown as Record<string, unknown>)));
  assert.ok(!("token_hash" in (context as unknown as Record<string, unknown>)));
});

test("an unresolvable token authenticates nothing", async () => {
  assert.equal(
    await authenticateAgentToken("Bearer nope", async () => null),
    null
  );
});

test("project identity comes from the resolver, never the request", async () => {
  const context = await authenticateAgentToken("Bearer tok", async () => ({
    credentialId: "c",
    agentId: "a",
    projectId: "project-from-credential",
  }));
  assert.equal(context?.projectId, "project-from-credential");
});

test("resolver failures propagate for a safe 500 upstream", async () => {
  await assert.rejects(
    authenticateAgentToken("Bearer tok", async () => {
      throw new Error("database down");
    }),
    /database down/
  );
});

test("middleware attaches identity and continues on success", async () => {
  const middleware = createAgentAuthMiddleware(async () => ({
    credentialId: "c",
    agentId: "a",
    projectId: "p",
  }));
  const req = fakeReq({ headers: { authorization: "Bearer tok" }, body: { projectId: "rogue" }, query: { projectId: "rogue" } });
  const fake = fakeRes();
  const { next, calls } = nextCounter();
  await middleware(req, fake.res, next);
  assert.equal(calls(), 1);
  assert.deepEqual(req.agent, { agentId: "a", projectId: "p", credentialId: "c" });
});

test("middleware answers 401 without leaking when resolution fails", async () => {
  const middleware = createAgentAuthMiddleware(async () => null);
  for (const headers of [
    {},
    { authorization: "Basic abc" },
    { authorization: "Bearer " },
    { authorization: "Bearer unknown-token-value" },
  ]) {
    const req = fakeReq({ headers });
    const fake = fakeRes();
    const { next, calls } = nextCounter();
    await middleware(req, fake.res, next);
    assert.equal(calls(), 0);
    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.body, { error: "Authentication required" });
  }
});

test("middleware converts unexpected failures to a safe 500", async () => {
  const middleware = createAgentAuthMiddleware(async () => {
    throw new Error("database down");
  });
  const req = fakeReq({ headers: { authorization: "Bearer tok" } });
  const fake = fakeRes();
  const { next, calls } = nextCounter();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(String(args.map((a) => String(a)).join(" ")));
  };
  try {
    await middleware(req, fake.res, next);
  } finally {
    console.error = original;
  }
  assert.equal(calls(), 0);
  assert.equal(fake.statusCode, 500);
  assert.deepEqual(fake.body, { error: "Authentication failed" });
  assert.ok(logged.every((line) => !line.includes("tok")));
});

async function makeAgent(tag: string): Promise<{
  projectId: string;
  agentId: string;
  token: string;
  credentialId: string;
}> {
  const project = await makeProject(uniqueName(tag));
  const agent = await createAgent(project.id, `edge-${tag}`);
  const cred = await createEnrollmentCredential(agent.id);
  return {
    projectId: project.id,
    agentId: agent.id,
    token: cred.token,
    credentialId: cred.id,
  };
}

async function cleanupProject(projectId: string): Promise<void> {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
}

async function authedContext(token: string) {
  const context = await authenticateAgentToken(token);
  assert.ok(context);
  return context;
}

test("valid Bearer token authenticates through the real middleware", async () => {
  if (!(await dbAvailable())) return;
  const made = await makeAgent("mw-valid");
  try {
    const req = fakeReq({ headers: { authorization: `Bearer ${made.token}` } });
    const fake = fakeRes();
    const { next, calls } = nextCounter();
    await authenticateAgent(req, fake.res, next);
    assert.equal(calls(), 1);
    assert.deepEqual(req.agent, {
      agentId: made.agentId,
      projectId: made.projectId,
      credentialId: made.credentialId,
    });
  } finally {
    await cleanupProject(made.projectId);
  }
});

test("invalid, revoked, and expired credentials are rejected with 401", async () => {
  if (!(await dbAvailable())) return;
  const made = await makeAgent("mw-reject");
  try {
    const attempt = async (token: string) => {
      const req = fakeReq({ headers: { authorization: `Bearer ${token}` } });
      const fake = fakeRes();
      const { next, calls } = nextCounter();
      await authenticateAgent(req, fake.res, next);
      return { calls: calls(), status: fake.statusCode, body: fake.body };
    };
    assert.deepEqual((await attempt("0".repeat(64))).status, 401);
    assert.equal((await attempt(made.token)).calls, 1);
    const expired = await createEnrollmentCredential(made.agentId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    assert.deepEqual((await attempt(expired.token)).status, 401);
    await revokeCredential(made.credentialId);
    const denied = await attempt(made.token);
    assert.equal(denied.calls, 0);
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.body, { error: "Authentication required" });
  } finally {
    await cleanupProject(made.projectId);
  }
});

test("a revoked agent is rejected with 401", async () => {
  if (!(await dbAvailable())) return;
  const made = await makeAgent("mw-agent-revoked");
  try {
    assert.equal(await revokeAgent(made.agentId), true);
    const req = fakeReq({ headers: { authorization: `Bearer ${made.token}` } });
    const fake = fakeRes();
    const { next, calls } = nextCounter();
    await authenticateAgent(req, fake.res, next);
    assert.equal(calls(), 0);
    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.body, { error: "Authentication required" });
  } finally {
    await cleanupProject(made.projectId);
  }
});

test("GET /me returns the safe identity and ignores request input", async () => {
  if (!(await dbAvailable())) return;
  const made = await makeAgent("me");
  const rogue = await makeProject(uniqueName("me-rogue"));
  try {
    const context = await authedContext(`Bearer ${made.token}`);
    const req = fakeReq({
      headers: { authorization: `Bearer ${made.token}` },
      params: { id: rogue.id },
      query: { projectId: rogue.id },
      body: { projectId: rogue.id, token: made.token },
      agent: context,
    });
    const fake = fakeRes();
    await getAgentMeController(req, fake.res);
    assert.equal(fake.statusCode, 200);
    const payload = fake.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      "createdAt",
      "id",
      "lastHeartbeatAt",
      "name",
      "projectId",
      "status",
      "updatedAt",
      "version",
    ]);
    assert.equal(payload.id, made.agentId);
    assert.equal(payload.projectId, made.projectId);
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes(made.token));
  } finally {
    await cleanupProject(made.projectId);
    await cleanupProject(rogue.id);
  }
});

test("GET /me requires authentication and handles a vanished agent", async () => {
  if (!(await dbAvailable())) return;
  const made = await makeAgent("me-gone");
  try {
    const anon = fakeRes();
    await getAgentMeController(fakeReq({ headers: {} }), anon.res);
    assert.equal(anon.statusCode, 401);
    const context = await authedContext(`Bearer ${made.token}`);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [made.agentId]);
    const gone = fakeRes();
    await getAgentMeController(fakeReq({ headers: {}, agent: context }), gone.res);
    assert.equal(gone.statusCode, 404);
    assert.deepEqual(gone.body, { error: "Agent not found" });
  } finally {
    await cleanupProject(made.projectId);
  }
});

test("heartbeat stamps version and heartbeat time", async () => {
  if (!(await dbAvailable())) return;
  const made = await makeAgent("hb");
  try {
    const context = await authedContext(`Bearer ${made.token}`);
    const req = fakeReq({
      headers: { authorization: `Bearer ${made.token}` },
      body: { version: "edge-1.2.3" },
      agent: context,
    });
    const fake = fakeRes();
    await postAgentHeartbeatController(req, fake.res);
    assert.equal(fake.statusCode, 200);
    const payload = fake.body as { version: string | null; lastHeartbeatAt: string | null; projectId: string };
    assert.equal(payload.version, "edge-1.2.3");
    assert.ok(payload.lastHeartbeatAt !== null);
    assert.equal(payload.projectId, made.projectId);
    assert.ok(!JSON.stringify(payload).includes(made.token));
    const plain = fakeReq({ headers: {}, agent: context });
    const plainRes = fakeRes();
    await postAgentHeartbeatController(plain, plainRes.res);
    assert.equal(plainRes.statusCode, 200);
    assert.equal(
      (plainRes.body as { version: string | null }).version,
      "edge-1.2.3"
    );
  } finally {
    await cleanupProject(made.projectId);
  }
});

test("a revoked agent cannot heartbeat and is never resurrected", async () => {
  if (!(await dbAvailable())) return;
  const made = await makeAgent("hb-revoked");
  try {
    const context = await authedContext(`Bearer ${made.token}`);
    assert.equal(await revokeAgent(made.agentId), true);
    const req = fakeReq({
      headers: { authorization: `Bearer ${made.token}` },
      body: { version: "9.9.9" },
      agent: context,
    });
    const fake = fakeRes();
    await postAgentHeartbeatController(req, fake.res);
    assert.equal(fake.statusCode, 403);
    assert.deepEqual(fake.body, { error: "Agent is revoked" });
    const row = (
      await pool.query(`SELECT status, version FROM agents WHERE id = $1`, [
        made.agentId,
      ])
    ).rows[0] as { status: string; version: string | null };
    assert.equal(row.status, "revoked");
    assert.notEqual(row.version, "9.9.9");
  } finally {
    await cleanupProject(made.projectId);
  }
});

test("malformed heartbeat versions are rejected with 400", async () => {
  if (!(await dbAvailable())) return;
  const made = await makeAgent("hb-bad");
  try {
    const context = await authedContext(`Bearer ${made.token}`);
    for (const version of ["", 123, "x".repeat(101)]) {
      const req = fakeReq({
        headers: {},
        body: { version },
        agent: context,
      });
      const fake = fakeRes();
      await postAgentHeartbeatController(req, fake.res);
      assert.equal(fake.statusCode, 400);
      assert.deepEqual(fake.body, { error: "Invalid agent version" });
    }
  } finally {
    await cleanupProject(made.projectId);
  }
});

test("heartbeat without authentication is rejected", async () => {
  if (!(await dbAvailable())) return;
  const fake = fakeRes();
  await postAgentHeartbeatController(
    fakeReq({ headers: {}, body: { version: "1.0.0" } }),
    fake.res
  );
  assert.equal(fake.statusCode, 401);
  assert.deepEqual(fake.body, { error: "Authentication required" });
});

test("unexpected heartbeat failures return a safe 500", async () => {
  if (!(await dbAvailable())) return;
  const made = await makeAgent("hb-500");
  try {
    const context = await authedContext(`Bearer ${made.token}`);
    const req = fakeReq({ headers: {}, agent: context });
    Object.defineProperty(req, "body", {
      get(): unknown {
        throw new Error("body exploded");
      },
    });
    const fake = fakeRes();
    await postAgentHeartbeatController(req, fake.res);
    assert.equal(fake.statusCode, 500);
    assert.deepEqual(fake.body, { error: "Failed to record heartbeat" });
  } finally {
    await cleanupProject(made.projectId);
  }
});
