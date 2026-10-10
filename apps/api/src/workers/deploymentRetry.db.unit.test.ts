import test from "node:test";
import assert from "node:assert/strict";
import pool from "../db/database.js";
import { createDeployment } from "../services/deploymentService.js";
import {
  claimNextJob,
  failJob,
  failJobTerminal,
} from "./deploymentQueue.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    const check = await pool.query(
      `SELECT to_regclass('public.deployment_jobs') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

async function createProject(name: string) {
  const result = await pool.query(
    `INSERT INTO projects (name, repository_url, branch) VALUES ($1, 'https://github.com/acme/app.git', 'main') RETURNING *`,
    [name]
  );
  return result.rows[0];
}

async function setupRunningJob(tag: string) {
  const project = await createProject(`rt-${tag}-${Date.now()}`);
  const deployment = await createDeployment({
    projectId: project.id,
    trigger: "manual",
    idempotencyKey: null,
  });
  const claimed = await claimNextJob(`rt-worker-${tag}`, 30_000);
  assert.ok(claimed);
  assert.equal(claimed.deploymentId, deployment.id);
  return { project, deployment, claimed, worker: `rt-worker-${tag}` };
}

async function deploymentRow(id: string) {
  return (
    await pool.query(
      `SELECT status, error_code FROM deployments WHERE id = $1`,
      [id]
    )
  ).rows[0];
}

async function jobRow(id: string) {
  return (
    await pool.query(
      `SELECT status, locked_by FROM deployment_jobs WHERE id = $1`,
      [id]
    )
  ).rows[0];
}

test("retryable failure persists the typed error code and requeues", async () => {
  if (!(await dbAvailable())) return;
  const { project, claimed, worker } = await setupRunningJob("typed");
  try {
    const outcome = await failJob(
      claimed.id,
      claimed.deploymentId,
      worker,
      "BUILD_FAILED: build blew up",
      "BUILD_FAILED"
    );
    assert.equal(outcome, "retrying");
    const dep = await deploymentRow(claimed.deploymentId);
    assert.equal(dep.error_code, "BUILD_FAILED");
    const job = await jobRow(claimed.id);
    assert.equal(job.status, "queued");
    assert.equal(job.locked_by, null);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("retryable failure without a code keeps the generic retry code", async () => {
  if (!(await dbAvailable())) return;
  const { project, claimed, worker } = await setupRunningJob("generic");
  try {
    const outcome = await failJob(
      claimed.id,
      claimed.deploymentId,
      worker,
      "something broke"
    );
    assert.equal(outcome, "retrying");
    const dep = await deploymentRow(claimed.deploymentId);
    assert.equal(dep.error_code, "DEPLOYMENT_RETRY");
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("retry exhaustion persists the typed code and stops", async () => {
  if (!(await dbAvailable())) return;
  const { project, claimed, worker } = await setupRunningJob("exhaust");
  try {
    await pool.query(
      `UPDATE deployment_jobs SET attempts = max_attempts WHERE id = $1`,
      [claimed.id]
    );
    const outcome = await failJob(
      claimed.id,
      claimed.deploymentId,
      worker,
      "HEALTH_CHECK_FAILED: still red",
      "HEALTH_CHECK_FAILED"
    );
    assert.equal(outcome, "failed");
    const dep = await deploymentRow(claimed.deploymentId);
    assert.equal(dep.status, "failed");
    assert.equal(dep.error_code, "HEALTH_CHECK_FAILED");
    const job = await jobRow(claimed.id);
    assert.equal(job.status, "failed");
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("permanent failure terminates immediately with the typed code", async () => {
  if (!(await dbAvailable())) return;
  const { project, claimed, worker } = await setupRunningJob("terminal");
  try {
    await failJobTerminal(
      claimed.id,
      claimed.deploymentId,
      worker,
      "CLONE_FAILED: no such repo",
      "CLONE_FAILED"
    );
    const dep = await deploymentRow(claimed.deploymentId);
    assert.equal(dep.status, "failed");
    assert.equal(dep.error_code, "CLONE_FAILED");
    const job = await jobRow(claimed.id);
    assert.equal(job.status, "failed");
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("failure from a stale worker is rejected and changes nothing", async () => {
  if (!(await dbAvailable())) return;
  const { project, claimed, worker } = await setupRunningJob("stale");
  try {
    await assert.rejects(
      failJob(claimed.id, claimed.deploymentId, "impostor", "boom", "BUILD_FAILED"),
      /no longer owned/
    );
    await assert.rejects(
      failJobTerminal(claimed.id, claimed.deploymentId, "impostor", "boom", "BUILD_FAILED"),
      /no longer owned/
    );
    const job = await jobRow(claimed.id);
    assert.equal(job.status, "running");
    assert.equal(job.locked_by, worker);
    const dep = await deploymentRow(claimed.deploymentId);
    assert.equal(dep.error_code, null);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});
