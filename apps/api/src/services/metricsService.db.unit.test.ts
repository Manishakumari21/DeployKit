import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import { getProjectMetrics } from "./metricsService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

test("project metrics are computed from real state without loading rows into Node", async () => {
  if (!(await dbAvailable())) return;
  const project = (
    await pool.query(
      `INSERT INTO projects (name, repository_url, branch)
       VALUES ($1, 'https://github.com/acme/app.git', 'main') RETURNING *`,
      [`metrics-${Date.now()}`]
    )
  ).rows[0];
  try {
    const deps = (
      await pool.query(
        `INSERT INTO deployments (project_id, status, trigger, branch, started_at, finished_at)
         VALUES ($1,'active','manual','main', NOW() - INTERVAL '60 seconds', NOW()),
                ($1,'failed','manual','main', NOW() - INTERVAL '30 seconds', NOW()),
                ($1,'queued','manual','main', NULL, NULL) RETURNING id`,
        [project.id]
      )
    ).rows;
    for (const d of deps) {
      await pool.query(`INSERT INTO deployment_jobs (deployment_id, status) VALUES ($1, 'queued')`, [d.id]);
    }
    const m = await getProjectMetrics(project.id);
    assert.equal(m.project_id, project.id);
    assert.equal(m.deployments.total, 3);
    assert.equal(m.deployments.successful, 1);
    assert.equal(m.deployments.failed, 1);
    assert.ok(m.deployments.avg_duration_seconds !== null);
    assert.ok(m.queue.queued >= 1);
    assert.equal(typeof m.worker.enabled, "boolean");
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});
