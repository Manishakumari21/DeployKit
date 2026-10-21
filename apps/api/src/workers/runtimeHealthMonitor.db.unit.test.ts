import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import { checkActiveRuntimeHealth } from "./runtimeHealthMonitor.js";
import { gateDb } from "../test/dbGate.js";

const SUITE = "workers/runtimeHealthMonitor.db.unit.test.ts";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"a".repeat(64)}`;

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

async function ready(): Promise<boolean> {
  return gateDb(SUITE, dbAvailable);
}

async function createProject(name: string) {
  const result = await pool.query(
    `INSERT INTO projects (name, repository_url, branch) VALUES ($1, 'https://github.com/acme/app.git', 'main') RETURNING *`,
    [name]
  );
  return result.rows[0];
}

async function createDeployment(projectId: string) {
  const result = await pool.query(
    `INSERT INTO deployments (project_id, status, trigger, branch) VALUES ($1, 'active', 'manual', 'main') RETURNING *`,
    [projectId]
  );
  return result.rows[0];
}

async function createRelease(deploymentId: string, projectId: string) {
  const result = await pool.query(
    `INSERT INTO releases (deployment_id, project_id, image_repository, image_digest, commit_sha, branch, status)
     VALUES ($1, $2, 'deploykit/app', $3, $4, 'main', 'active') RETURNING *`,
    [deploymentId, projectId, DIGEST, SHA]
  );
  return result.rows[0];
}

async function createRuntime(releaseId: string, name: string) {
  const result = await pool.query(
    `INSERT INTO runtime_instances (release_id, status, container_name, container_port, host_port, ip_address, started_at)
     VALUES ($1, 'running', $2, 3000, 31001, '172.19.0.50', CURRENT_TIMESTAMP - INTERVAL '10 minutes')
     RETURNING *`,
    [releaseId, name]
  );
  return result.rows[0];
}

test("a dead runtime container is detected and recorded as unhealthy", async () => {
  if (!(await ready())) return;
  const project = await createProject(`rh-dead-${Date.now()}`);
  try {
    const deployment = await createDeployment(project.id);
    const release = await createRelease(deployment.id, project.id);
    const runtime = await createRuntime(release.id, `dk-pdead${Date.now() % 100000}`);

    const summary = await checkActiveRuntimeHealth({
      runtimeManager: { isRunning: async () => false },
      gracePeriodMs: 0,
    });

    assert.equal(summary.unhealthy, 1);
    const after = await pool.query(
      `SELECT status, error_code, last_health_check_at FROM runtime_instances WHERE id = $1`,
      [runtime.id]
    );
    assert.equal(after.rows[0].status, "unhealthy");
    assert.equal(after.rows[0].error_code, "RUNTIME_CONTAINER_NOT_RUNNING");
    assert.ok(
      after.rows[0].last_health_check_at,
      "a health check must record when it last ran"
    );

    const events = await pool.query(
      `SELECT event_type FROM deployment_events WHERE deployment_id = $1 AND event_type = 'runtime.unhealthy'`,
      [deployment.id]
    );
    assert.equal(events.rowCount, 1, "an unhealthy runtime must produce an event");

    const releaseAfter = await pool.query(
      `SELECT error_code FROM releases WHERE id = $1`,
      [release.id]
    );
    assert.equal(releaseAfter.rows[0].error_code, "RUNTIME_CONTAINER_NOT_RUNNING");
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("a healthy runtime keeps running and refreshes its health timestamp", async () => {
  if (!(await ready())) return;
  const project = await createProject(`rh-ok-${Date.now()}`);
  try {
    const deployment = await createDeployment(project.id);
    const release = await createRelease(deployment.id, project.id);
    const runtime = await createRuntime(release.id, `dk-pok${Date.now() % 100000}`);

    const summary = await checkActiveRuntimeHealth({
      runtimeManager: { isRunning: async () => true },
      gracePeriodMs: 0,
    });

    assert.equal(summary.healthy, 1);
    assert.equal(summary.unhealthy, 0);
    const after = await pool.query(
      `SELECT status, error_code, last_health_check_at FROM runtime_instances WHERE id = $1`,
      [runtime.id]
    );
    assert.equal(after.rows[0].status, "running");
    assert.equal(after.rows[0].error_code, null);
    assert.ok(after.rows[0].last_health_check_at);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("a runtime that recovers is restored to running", async () => {
  if (!(await ready())) return;
  const project = await createProject(`rh-recover-${Date.now()}`);
  try {
    const deployment = await createDeployment(project.id);
    const release = await createRelease(deployment.id, project.id);
    const runtime = await createRuntime(release.id, `dk-prec${Date.now() % 100000}`);
    await pool.query(
      `UPDATE runtime_instances SET status = 'unhealthy', error_code = 'RUNTIME_CONTAINER_NOT_RUNNING' WHERE id = $1`,
      [runtime.id]
    );

    const summary = await checkActiveRuntimeHealth({
      runtimeManager: { isRunning: async () => true },
      gracePeriodMs: 0,
    });

    assert.equal(summary.healthy, 1);
    const after = await pool.query(
      `SELECT status, error_code FROM runtime_instances WHERE id = $1`,
      [runtime.id]
    );
    assert.equal(after.rows[0].status, "running");
    assert.equal(after.rows[0].error_code, null);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("runtimes inside the grace period are not probed", async () => {
  if (!(await ready())) return;
  const project = await createProject(`rh-grace-${Date.now()}`);
  try {
    const deployment = await createDeployment(project.id);
    const release = await createRelease(deployment.id, project.id);
    const runtime = await createRuntime(release.id, `dk-pgra${Date.now() % 100000}`);
    await pool.query(
      `UPDATE runtime_instances SET started_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [runtime.id]
    );

    let probed = false;
    const summary = await checkActiveRuntimeHealth({
      runtimeManager: {
        isRunning: async () => {
          probed = true;
          return true;
        },
      },
      now: () => new Date(Date.now()),
      gracePeriodMs: 60_000,
    });

    assert.equal(probed, false, "a freshly started runtime must not be probed");
    assert.equal(summary.checked + summary.skipped, 1);
    assert.equal(summary.checked, 0);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});
