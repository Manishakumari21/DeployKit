import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import {
  createDeployment,
  getDeploymentEvents,
} from "../services/deploymentService.js";
import {
  claimNextJob,
  failJob,
  recoverExpiredJobs,
} from "./deploymentQueue.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

async function createProject(name: string) {
  const result = await pool.query(
    `
    INSERT INTO projects (name, repository_url, branch)
    VALUES ($1, 'https://github.com/acme/app.git', 'main')
    RETURNING *
    `,
    [name]
  );
  return result.rows[0];
}

test("idempotent deployment creation returns the same row", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`idemp-${Date.now()}`);
  try {
    const key = `key-${Date.now()}-${Math.random()}`;
    const first = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: key,
    });
    const second = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: key,
    });
    assert.equal(first.id, second.id);
    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM deployments WHERE project_id = $1 AND idempotency_key = $2`,
      [project.id, key]
    );
    assert.equal(count.rows[0].n, 1);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("claim increments attempts and records attempt history", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`claim-${Date.now()}`);
  try {
    const deployment = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    const claimed = await claimNextJob("test-worker-1", 30_000);
    assert.ok(claimed);
    assert.equal(claimed?.deploymentId, deployment.id);
    assert.equal(claimed?.attempts, 1);
    const attempts = await pool.query(
      `SELECT * FROM deployment_attempts WHERE deployment_id = $1`,
      [deployment.id]
    );
    assert.equal(attempts.rowCount, 1);
    await failJob(
      claimed!.id,
      claimed!.deploymentId,
      "test-worker-1",
      "test failure"
    );
    const events = await getDeploymentEvents(deployment.id);
    const types = events.map((e) => e.event_type);
    assert.ok(types.includes("deployment.claimed"));
    assert.ok(types.includes("deployment.retry_scheduled"));
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("expired leases are recovered with audit events", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`recover-${Date.now()}`);
  try {
    const deployment = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    const claimed = await claimNextJob("test-worker-2", 50);
    assert.ok(claimed);
    await pool.query(
      `UPDATE deployment_jobs SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1`,
      [claimed!.id]
    );
    const recovered = await recoverExpiredJobs();
    assert.ok(recovered >= 1);
    const events = await getDeploymentEvents(deployment.id);
    assert.ok(
      events.some((e) => e.event_type === "deployment.lease_recovered")
    );
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("central worker cannot claim edge-targeted jobs but still claims central ones", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const { createAgent } = await import("../agents/agentService.js");
  const { claimAgentJob } = await import("../agents/agentJobService.js");
  const project = await createProject(`edge-isolation-${Date.now()}`);
  try {
    const agent = await createAgent(project.id, `edge-iso-${Date.now()}`);
    const edgeDeployment = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
      targetAgentId: agent.id,
    });
    assert.ok(edgeDeployment);
    const centralDeployment = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    assert.ok(centralDeployment);

    const claimed = await claimNextJob("central-iso-probe", 30_000);
    assert.ok(claimed);
    assert.equal(claimed?.deploymentId, centralDeployment.id);

    await failJob(claimed!.id, claimed!.deploymentId, "central-iso-probe", "release central job");
    const none = await claimNextJob("central-iso-probe", 30_000);
    assert.equal(none, null);
    const edgeJob = await pool.query(
      `SELECT status FROM deployment_jobs WHERE deployment_id = $1`,
      [edgeDeployment.id]
    );
    assert.equal(edgeJob.rows[0].status, "queued");

    const agentClaimed = await claimAgentJob(agent.id);
    assert.ok(agentClaimed);
    assert.equal(agentClaimed?.deploymentId, edgeDeployment.id);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("an expired edge lease is never stolen by the central worker", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const { createAgent } = await import("../agents/agentService.js");
  const { claimAgentJob } = await import("../agents/agentJobService.js");
  const project = await createProject(`edge-lease-${Date.now()}`);
  try {
    const agent = await createAgent(project.id, `edge-lease-${Date.now()}`);
    const edgeDeployment = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
      targetAgentId: agent.id,
    });
    assert.ok(edgeDeployment);
    const first = await claimAgentJob(agent.id);
    assert.ok(first);
    await pool.query(
      `UPDATE deployment_jobs
       SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE id = $1`,
      [first!.id]
    );

    assert.equal(await claimNextJob("central-lease-probe", 30_000), null);

    const recovered = await recoverExpiredJobs();
    assert.ok(recovered >= 1);
    assert.equal(await claimNextJob("central-lease-probe", 30_000), null);

    const second = await claimAgentJob(agent.id);
    assert.ok(second);
    assert.equal(second?.id, first!.id);
    assert.equal(second?.attempts, 2);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});
