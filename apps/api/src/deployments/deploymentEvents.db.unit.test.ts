import test from "node:test";
import assert from "node:assert/strict";
import pool from "../db/database.js";
import { recordDeploymentEvent } from "./deploymentEvents.js";
import { redactSecrets } from "../services/deploymentLogService.js";
import { redactForLog } from "../agents/edgeJobSchema.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    const check = await pool.query(
      `SELECT to_regclass('public.deployment_events') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

test("log redactor and edge redactor are a single implementation", () => {
  const samples = [
    "Bearer abcdef123456 denied",
    "postgres://u:pw@host:5432/db",
    "password: hunter2",
    "plain diagnostics with uuid 550e8400-e29b-41d4-a716-446655440000",
  ];
  for (const sample of samples) {
    assert.equal(redactSecrets(sample), redactForLog(sample));
  }
});

test("deployment event messages are redacted before persistence", async () => {
  if (!(await dbAvailable())) return;
  const project = (
    await pool.query(
      `INSERT INTO projects (name, repository_url, branch) VALUES ($1, 'https://github.com/acme/app.git', 'main') RETURNING *`,
      [`ev-redact-${Date.now()}`]
    )
  ).rows[0];
  try {
    const deployment = (
      await pool.query(
        `INSERT INTO deployments (project_id, status, trigger, branch) VALUES ($1, 'queued', 'manual', 'main') RETURNING *`,
        [project.id]
      )
    ).rows[0];
    const secret = "ghp_sekrit1234567890";
    const client = await pool.connect();
    try {
      await recordDeploymentEvent(client, {
        deploymentId: deployment.id,
        eventType: "deployment.queued",
        statusFrom: null,
        statusTo: "queued",
        message: `clone failed with token ${secret} for project ${project.id}`,
        metadata: { note: `key ${secret}`, attempt: 1 },
      });
    } finally {
      client.release();
    }
    const row = (
      await pool.query(
        `SELECT message, metadata FROM deployment_events WHERE deployment_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [deployment.id]
      )
    ).rows[0];
    assert.ok(!row.message.includes(secret), "secret must not persist in event message");
    assert.ok(row.message.includes(project.id), "non-secret diagnostics preserved");
    assert.equal(row.metadata.attempt, 1);
    assert.ok(
      typeof row.metadata.note === "string" && !row.metadata.note.includes(secret),
      "secret must not persist in event metadata values"
    );
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});
