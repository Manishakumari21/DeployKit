import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import { createDeployment } from "../services/deploymentService.js";
import {
  AgentError,
  createAgent,
  createEnrollmentCredential,
  getAgentById,
  hashAgentToken,
  listProjectAgents,
  resolveCredential,
  revokeAgent,
  revokeCredential,
  rotateCredential,
  updateAgentHeartbeat,
} from "../agents/agentService.js";

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
  return `edge-${tag}-${Date.now()}-${rand}`;
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

async function cleanupProject(projectId: string): Promise<void> {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
}

async function makeDeployment(projectId: string): Promise<{ id: string }> {
  const row = (
    await pool.query(
      `INSERT INTO deployments (project_id, status, trigger, branch)
       VALUES ($1, 'queued', 'manual', 'main')
       RETURNING id`,
      [projectId]
    )
  ).rows[0] as { id: string };
  return row;
}

async function getDeploymentTarget(deploymentId: string): Promise<{
  target_agent_id: string | null;
}> {
  const row = (
    await pool.query(`SELECT target_agent_id FROM deployments WHERE id = $1`, [
      deploymentId,
    ])
  ).rows[0] as { target_agent_id: string | null };
  return row;
}

test("creates an agent scoped to its project", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("create"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    assert.match(agent.id, /^[0-9a-f-]{36}$/);
    assert.equal(agent.projectId, project.id);
    assert.equal(agent.name, "edge-1");
    assert.equal(agent.status, "pending");
    assert.equal(agent.lastHeartbeatAt, null);
    assert.equal(agent.version, null);
    assert.ok(Date.parse(agent.createdAt) > 0);
    const fetched = await getAgentById(agent.id);
    assert.deepEqual(fetched, agent);
    assert.deepEqual(
      (await listProjectAgents(project.id)).map((a) => a.id),
      [agent.id]
    );
  } finally {
    await cleanupProject(project.id);
  }
});

test("agent creation rejects missing or malformed projects", async () => {
  if (!(await dbAvailable())) return;
  await assert.rejects(
    createAgent("00000000-0000-0000-0000-000000000000", "edge-x"),
    (e: unknown) => e instanceof AgentError && e.code === "PROJECT_NOT_FOUND"
  );
  await assert.rejects(
    createAgent("not-a-uuid", "edge-x"),
    (e: unknown) => e instanceof AgentError && e.code === "INVALID_PROJECT"
  );
  await assert.rejects(
    createAgent("00000000-0000-0000-0000-000000000000", "   "),
    (e: unknown) => e instanceof AgentError && e.code === "INVALID_NAME"
  );
  assert.equal(await getAgentById("not-a-uuid"), null);
  assert.equal(await getAgentById("00000000-0000-0000-0000-000000000000"), null);
});

test("project deletion cascades its agents", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("cascade"));
  const agent = await createAgent(project.id, "edge-1");
  const cred = await createEnrollmentCredential(agent.id);
  await cleanupProject(project.id);
  assert.equal(await getAgentById(agent.id), null);
  assert.deepEqual(await listProjectAgents(project.id), []);
  const remaining = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM agent_credentials WHERE id = $1`,
      [cred.id]
    )
  ).rows[0].n as number;
  assert.equal(remaining, 0);
});

test("agent names are unique per project but reusable across projects", async () => {
  if (!(await dbAvailable())) return;
  const first = await makeProject(uniqueName("dup-a"));
  const second = await makeProject(uniqueName("dup-b"));
  try {
    const same = await createAgent(first.id, "same-name");
    await assert.rejects(
      createAgent(first.id, "same-name"),
      (e: unknown) =>
        e instanceof AgentError &&
        e.code === "AGENT_NAME_TAKEN" &&
        e.status === 409
    );
    const other = await createAgent(second.id, "same-name");
    assert.equal(other.name, "same-name");
    assert.equal(other.projectId, second.id);
    assert.deepEqual(
      (await listProjectAgents(first.id)).map((a) => a.id),
      [same.id]
    );
    assert.deepEqual(
      (await listProjectAgents(second.id)).map((a) => a.id),
      [other.id]
    );
  } finally {
    await cleanupProject(first.id);
    await cleanupProject(second.id);
  }
});

test("credential is stored only as a SHA-256 digest", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("hash"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    const cred = await createEnrollmentCredential(agent.id);
    assert.match(cred.token, /^[0-9a-f]{64}$/);
    const stored = (
      await pool.query(
        `SELECT token_hash FROM agent_credentials WHERE id = $1`,
        [cred.id]
      )
    ).rows[0] as { token_hash: string };
    assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(stored.token_hash, hashAgentToken(cred.token));
    assert.ok(!stored.token_hash.includes(cred.token));
  } finally {
    await cleanupProject(project.id);
  }
});

test("the issued raw credential resolves to its agent and project", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("resolve"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    const cred = await createEnrollmentCredential(agent.id);
    const resolved = await resolveCredential(cred.token);
    assert.ok(resolved);
    assert.equal(resolved.credentialId, cred.id);
    assert.equal(resolved.agentId, agent.id);
    assert.equal(resolved.projectId, project.id);
    const used = (
      await pool.query(
        `SELECT last_used_at FROM agent_credentials WHERE id = $1`,
        [cred.id]
      )
    ).rows[0] as { last_used_at: string | null };
    assert.ok(used.last_used_at !== null);
  } finally {
    await cleanupProject(project.id);
  }
});

test("unknown and malformed credentials resolve to null", async () => {
  if (!(await dbAvailable())) return;
  assert.equal(await resolveCredential("0".repeat(64)), null);
  assert.equal(await resolveCredential("not-a-credential"), null);
  assert.equal(await resolveCredential(""), null);
  assert.equal(await resolveCredential(null), null);
  assert.equal(await resolveCredential(undefined), null);
  assert.equal(await revokeCredential("not-a-uuid"), false);
});

test("revoked credentials are rejected and revocation is idempotent", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("revoke"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    const cred = await createEnrollmentCredential(agent.id);
    assert.ok(await resolveCredential(cred.token));
    assert.equal(await revokeCredential(cred.id), true);
    assert.equal(await resolveCredential(cred.token), null);
    assert.equal(await revokeCredential(cred.id), false);
    assert.equal(await revokeCredential("00000000-0000-0000-0000-000000000000"), false);
  } finally {
    await cleanupProject(project.id);
  }
});

test("expired credentials are rejected while future-dated ones resolve", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("expiry"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    const dead = await createEnrollmentCredential(agent.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    assert.equal(await resolveCredential(dead.token), null);
    const live = await createEnrollmentCredential(agent.id, {
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    assert.ok(await resolveCredential(live.token));
    await assert.rejects(
      createEnrollmentCredential(agent.id, { expiresAt: "not-a-date" }),
      (e: unknown) => e instanceof AgentError && e.code === "INVALID_EXPIRY"
    );
  } finally {
    await cleanupProject(project.id);
  }
});

test("each credential digest is unique", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("unique"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    const first = await createEnrollmentCredential(agent.id);
    const second = await createEnrollmentCredential(agent.id);
    assert.notEqual(first.id, second.id);
    assert.notEqual(
      hashAgentToken(first.token),
      hashAgentToken(second.token)
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO agent_credentials (agent_id, token_hash)
         VALUES ($1, $2)`,
        [agent.id, hashAgentToken(first.token)]
      )
    );
  } finally {
    await cleanupProject(project.id);
  }
});

test("agent deletion cascades its credentials", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("agentcascade"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    const cred = await createEnrollmentCredential(agent.id);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agent.id]);
    const remaining = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM agent_credentials WHERE id = $1`,
        [cred.id]
      )
    ).rows[0].n as number;
    assert.equal(remaining, 0);
    assert.equal(await resolveCredential(cred.token), null);
  } finally {
    await cleanupProject(project.id);
  }
});

test("deployments default to a NULL target (central worker)", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("nulltarget"));
  try {
    const deployment = await makeDeployment(project.id);
    assert.equal((await getDeploymentTarget(deployment.id)).target_agent_id, null);
    const viaService = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    assert.equal(viaService?.target_agent_id ?? null, null);
  } finally {
    await cleanupProject(project.id);
  }
});

test("a deployment can target an agent from its own project", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("target"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    const deployment = await makeDeployment(project.id);
    await pool.query(
      `UPDATE deployments SET target_agent_id = $1 WHERE id = $2`,
      [agent.id, deployment.id]
    );
    assert.equal(
      (await getDeploymentTarget(deployment.id)).target_agent_id,
      agent.id
    );
  } finally {
    await cleanupProject(project.id);
  }
});

test("cross-project deployment targets are rejected", async () => {
  if (!(await dbAvailable())) return;
  const home = await makeProject(uniqueName("home"));
  const away = await makeProject(uniqueName("away"));
  try {
    const foreign = await createAgent(away.id, "edge-1");
    const deployment = await makeDeployment(home.id);
    await assert.rejects(
      pool.query(`UPDATE deployments SET target_agent_id = $1 WHERE id = $2`, [
        foreign.id,
        deployment.id,
      ])
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO deployments (project_id, status, trigger, branch, target_agent_id)
         VALUES ($1, 'queued', 'manual', 'main', $2)`,
        [home.id, foreign.id]
      )
    );
    assert.equal((await getDeploymentTarget(deployment.id)).target_agent_id, null);
  } finally {
    await cleanupProject(home.id);
    await cleanupProject(away.id);
  }
});

test("deleting an agent preserves deployment history with a NULL target", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("history"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    const deployment = await makeDeployment(project.id);
    await pool.query(
      `UPDATE deployments SET target_agent_id = $1 WHERE id = $2`,
      [agent.id, deployment.id]
    );
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agent.id]);
    const row = (
      await pool.query(
        `SELECT id, target_agent_id FROM deployments WHERE id = $1`,
        [deployment.id]
      )
    ).rows[0] as { id: string; target_agent_id: string | null };
    assert.equal(row.id, deployment.id);
    assert.equal(row.target_agent_id, null);
  } finally {
    await cleanupProject(project.id);
  }
});

test("job lease owner is tracked separately from the requested target", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("lease"));
  try {
    const target = await createAgent(project.id, "edge-target");
    const leaseHolder = await createAgent(project.id, "edge-lease");
    const deployment = await makeDeployment(project.id);
    await pool.query(
      `UPDATE deployments SET target_agent_id = $1 WHERE id = $2`,
      [target.id, deployment.id]
    );
    const job = (
      await pool.query(
        `INSERT INTO deployment_jobs (deployment_id, status)
         VALUES ($1, 'queued')
         RETURNING id`,
        [deployment.id]
      )
    ).rows[0] as { id: string };
    const initial = (
      await pool.query(
        `SELECT claimed_agent_id FROM deployment_jobs WHERE id = $1`,
        [job.id]
      )
    ).rows[0] as { claimed_agent_id: string | null };
    assert.equal(initial.claimed_agent_id, null);
    await pool.query(
      `UPDATE deployment_jobs SET claimed_agent_id = $1 WHERE id = $2`,
      [leaseHolder.id, job.id]
    );
    const after = (
      await pool.query(
        `SELECT d.target_agent_id, j.claimed_agent_id
         FROM deployments d
         JOIN deployment_jobs j ON j.deployment_id = d.id
         WHERE d.id = $1`,
        [deployment.id]
      )
    ).rows[0] as { target_agent_id: string; claimed_agent_id: string };
    assert.equal(after.target_agent_id, target.id);
    assert.equal(after.claimed_agent_id, leaseHolder.id);
    assert.notEqual(after.target_agent_id, after.claimed_agent_id);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [leaseHolder.id]);
    const cleared = (
      await pool.query(
        `SELECT claimed_agent_id FROM deployment_jobs WHERE id = $1`,
        [job.id]
      )
    ).rows[0] as { claimed_agent_id: string | null };
    assert.equal(cleared.claimed_agent_id, null);
  } finally {
    await cleanupProject(project.id);
  }
});

test("legacy central deployments stay valid with NULL targets", async () => {
  if (!(await dbAvailable())) return;
  const before = (
    await pool.query(`SELECT COUNT(*)::int AS n FROM deployments`)
  ).rows[0].n as number;
  const project = await makeProject(uniqueName("legacy"));
  try {
    const deployment = await makeDeployment(project.id);
    const row = (
      await pool.query(
        `SELECT status, target_agent_id FROM deployments WHERE id = $1`,
        [deployment.id]
      )
    ).rows[0] as { status: string; target_agent_id: string | null };
    assert.equal(row.status, "queued");
    assert.equal(row.target_agent_id, null);
    const during = (
      await pool.query(`SELECT COUNT(*)::int AS n FROM deployments`)
    ).rows[0].n as number;
    assert.equal(during, before + 1);
  } finally {
    await cleanupProject(project.id);
  }
  const after = (
    await pool.query(`SELECT COUNT(*)::int AS n FROM deployments`)
  ).rows[0].n as number;
  assert.equal(after, before);
});

test("agents schema carries the intended constraints and indexes", async () => {
  if (!(await dbAvailable())) return;
  const agentColumns = (
    await pool.query(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'agents'
       ORDER BY column_name`
    )
  ).rows.map((r: { column_name: string }) => r.column_name);
  assert.deepEqual(agentColumns, [
    "created_at",
    "id",
    "last_heartbeat_at",
    "name",
    "project_id",
    "status",
    "updated_at",
    "version",
  ]);

  const credColumns = (
    await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'agent_credentials'
       ORDER BY column_name`
    )
  ).rows.map((r: { column_name: string }) => r.column_name);
  assert.deepEqual(credColumns, [
    "agent_id",
    "created_at",
    "expires_at",
    "id",
    "last_used_at",
    "revoked_at",
    "token_hash",
  ]);

  const unique = (
    await pool.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'agents'::regclass AND contype = 'u'`
    )
  ).rows.map((r: { conname: string }) => r.conname);
  assert.ok(unique.includes("agents_project_name_unique"));

  const checks = (
    await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'agents'::regclass AND contype = 'c'`
    )
  ).rows.map((r: { def: string }) => r.def);
  assert.ok(checks.some((d) => d.includes("pending") && d.includes("revoked")));

  const deletes = (
    await pool.query(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid IN ('agents'::regclass, 'agent_credentials'::regclass,
                          'deployments'::regclass, 'deployment_jobs'::regclass)
         AND contype = 'f'
         AND conname IN ('agents_project_id_fkey',
                         'agent_credentials_agent_id_fkey',
                         'deployments_target_agent_id_fkey',
                         'deployment_jobs_claimed_agent_id_fkey')`
    )
  ).rows as { conname: string; confdeltype: string }[];
  const rule = (name: string): string | undefined =>
    deletes.find((d) => d.conname === name)?.confdeltype;
  assert.equal(rule("agents_project_id_fkey"), "c");
  assert.equal(rule("agent_credentials_agent_id_fkey"), "c");
  assert.equal(rule("deployments_target_agent_id_fkey"), "n");
  assert.equal(rule("deployment_jobs_claimed_agent_id_fkey"), "n");

  const indexes = (
    await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('agents_project_status_idx',
                           'agents_heartbeat_idx',
                           'agent_credentials_agent_idx',
                           'deployments_target_agent_idx',
                           'deployment_jobs_claimed_agent_idx')`
    )
  ).rows.map((r: { indexname: string }) => r.indexname);
  assert.equal(indexes.length, 5);

  const triggers = (
    await pool.query(
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'deployments'::regclass AND NOT tgisinternal`
    )
  ).rows.map((r: { tgname: string }) => r.tgname);
  assert.ok(triggers.includes("deployments_target_agent_project_chk"));
});

test("raw credentials never reach logs or list/get payloads", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("nolog"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    const calls: string[] = [];
    const original = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      debug: console.debug,
    };
    console.log = (...args: unknown[]): void => {
      calls.push(String(args.map((a) => String(a)).join(" ")));
    };
    console.error = console.log;
    console.warn = console.log;
    console.debug = console.log;
    let token = "";
    try {
      const cred = await createEnrollmentCredential(agent.id);
      token = cred.token;
      await resolveCredential(token);
      await updateAgentHeartbeat(agent.id, "0.1.0");
    } finally {
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
      console.debug = original.debug;
    }
    assert.ok(token.length > 0);
    assert.ok(calls.every((line) => !line.includes(token)));

    for (const view of [
      (await getAgentById(agent.id)) as unknown as Record<string, unknown>,
      ...(
        (await listProjectAgents(project.id)) as unknown as Record<
          string,
          unknown
        >[]
      ),
    ]) {
      assert.ok(!("token" in view));
      assert.ok(!("token_hash" in view));
      assert.ok(!Object.values(view).includes(token));
    }
  } finally {
    await cleanupProject(project.id);
  }
});

test("rotation issues a fresh credential and revokes the old ones", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("rotate"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    const old = await createEnrollmentCredential(agent.id);
    const extra = await createEnrollmentCredential(agent.id);
    assert.ok(await resolveCredential(extra.token));
    const next = await rotateCredential(agent.id);
    assert.match(next.token, /^[0-9a-f]{64}$/);
    assert.notEqual(next.token, old.token);
    assert.ok(await resolveCredential(next.token));
    assert.equal(await resolveCredential(old.token), null);
    assert.equal(await resolveCredential(extra.token), null);
    const revoked = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM agent_credentials
         WHERE agent_id = $1 AND revoked_at IS NOT NULL`,
        [agent.id]
      )
    ).rows[0].n as number;
    assert.equal(revoked, 2);
    await assert.rejects(
      rotateCredential("00000000-0000-0000-0000-000000000000"),
      (e: unknown) => e instanceof AgentError && e.code === "AGENT_NOT_FOUND"
    );
  } finally {
    await cleanupProject(project.id);
  }
});

test("revoking an agent disables its credentials and heartbeat", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("agentrevoke"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    const cred = await createEnrollmentCredential(agent.id);
    assert.ok(await resolveCredential(cred.token));
    const before = await updateAgentHeartbeat(agent.id, "0.1.0");
    assert.equal(before.version, "0.1.0");
    assert.ok(before.lastHeartbeatAt !== null);
    assert.equal(await revokeAgent(agent.id), true);
    assert.equal(await revokeAgent(agent.id), false);
    assert.equal((await getAgentById(agent.id))?.status, "revoked");
    assert.equal(await resolveCredential(cred.token), null);
    await assert.rejects(
      updateAgentHeartbeat(agent.id),
      (e: unknown) => e instanceof AgentError && e.code === "AGENT_REVOKED"
    );
    await assert.rejects(
      createEnrollmentCredential(agent.id),
      (e: unknown) => e instanceof AgentError && e.code === "AGENT_REVOKED"
    );
    await assert.rejects(
      rotateCredential(agent.id),
      (e: unknown) => e instanceof AgentError && e.code === "AGENT_REVOKED"
    );
  } finally {
    await cleanupProject(project.id);
  }
});

test("concurrent credential creation yields distinct working credentials", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("concurrent"));
  try {
    const agent = await createAgent(project.id, "edge-1");
    const created = await Promise.all(
      Array.from({ length: 10 }, () => createEnrollmentCredential(agent.id))
    );
    const hashes = created.map((c) => hashAgentToken(c.token));
    assert.equal(new Set(hashes).size, created.length);
    const resolved = await Promise.all(
      created.map((c) => resolveCredential(c.token))
    );
    assert.ok(
      resolved.every(
        (r) => r !== null && r.agentId === agent.id && r.projectId === project.id
      )
    );
    const live = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM agent_credentials
         WHERE agent_id = $1 AND revoked_at IS NULL`,
        [agent.id]
      )
    ).rows[0].n as number;
    assert.equal(live, created.length);
  } finally {
    await cleanupProject(project.id);
  }
});
