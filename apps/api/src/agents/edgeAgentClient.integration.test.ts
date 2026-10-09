// Phase 12.5: edge client ↔ control-plane HTTP contract test.
//
// Real Express app + real PostgreSQL + real EdgeAgentClient. Proves the
// client's request paths match the server's actual route mount
// (/api/agent, see app.ts) and that the full claim → heartbeat → fail
// round trip works over HTTP. Guarded by DB availability; skipped without
// a database (never faked).
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import pool from "../db/database.js";
import app from "../app.js";
import {
  createAgent,
  createEnrollmentCredential,
} from "./agentService.js";
import { createDeployment } from "../services/deploymentService.js";
import {
  EdgeAgentClient,
  EdgeApiDefinitiveError,
} from "./edgeAgentClient.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.agents') AS agents,
              to_regclass('public.deployment_jobs') AS jobs`
    );
    return check.rows[0].agents !== null && check.rows[0].jobs !== null;
  } catch {
    return false;
  }
}

async function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
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

test("client paths match the server mount and round-trip over HTTP", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(`edgehttp-${Date.now()}`);
  const { baseUrl, close } = await startServer();
  try {
    const agent = await createAgent(project.id, "http-probe");
    const cred = await createEnrollmentCredential(agent.id);
    const client = new EdgeAgentClient({ baseUrl, token: cred.token });

    // No work: 200 envelope (a wrong path would surface as 404 → throw).
    assert.deepEqual(await client.claimJob(), { job: null });

    // Full round trip against the real routes.
    const deployment = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
      targetAgentId: agent.id,
    });
    assert.ok(deployment);
    const claimed = (await client.claimJob()) as {
      job: { id: string; deploymentId: string; image: null };
    };
    assert.equal(claimed.job.deploymentId, deployment.id);
    assert.equal(claimed.job.image, null);
    const state = (await client.heartbeatJob(claimed.job.id)) as {
      job: { status: string };
    };
    assert.equal(state.job.status, "running");
    await client.failJob(claimed.job.id, "EDGE_PROBE", "probe failure");
    const row = (
      await pool.query(`SELECT status FROM deployment_jobs WHERE deployment_id = $1`, [
        deployment.id,
      ])
    ).rows[0] as { status: string };
    assert.equal(row.status, "queued");
  } finally {
    await close();
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("revoked credentials are rejected over HTTP as definitive", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(`edgehttp-auth-${Date.now()}`);
  const { baseUrl, close } = await startServer();
  try {
    const client = new EdgeAgentClient({ baseUrl, token: "not-a-real-token" });
    await assert.rejects(client.claimJob(), EdgeApiDefinitiveError);
  } finally {
    await close();
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});
