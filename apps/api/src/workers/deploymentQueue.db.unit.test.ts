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
