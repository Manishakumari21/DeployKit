import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import {
  appendLog,
  appendOutput,
  deleteExpiredLogs,
  getDeploymentLogUsage,
  listLogs,
  normalizeLogLine,
  redactSecrets,
  safeAppendLog,
} from "./deploymentLogService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1 FROM deployment_logs LIMIT 1");
    return true;
  } catch {
    return false;
  }
}

async function createProject(name: string) {
  return (
    await pool.query(
      `INSERT INTO projects (name, repository_url, branch)
       VALUES ($1, 'https://github.com/acme/app.git', 'main') RETURNING *`,
      [name]
    )
  ).rows[0];
}

async function createDeployment(projectId: string) {
  return (
    await pool.query(
      `INSERT INTO deployments (project_id, status, trigger, branch)
       VALUES ($1, 'building', 'manual', 'main') RETURNING *`,
      [projectId]
    )
  ).rows[0];
}

test("redaction removes tokens and private keys before persistence", () => {
  const secret = "token ghp_abc123XYZ and bearer mysecrettoken123 plus -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
  const out = redactSecrets(secret);
  assert.ok(!out.includes("ghp_abc123XYZ"));
  assert.ok(!out.includes("BEGIN RSA PRIVATE KEY"));
});

test("normalizeLogLine strips ANSI and control chars", () => {
  const line = normalizeLogLine("[32m#1 done[0m\r\n", 8192);
  assert.equal(line, "#1 done");
});

test("append + cursor pagination + source/level filters use real DB", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`logs-${Date.now()}`);
  const dep = await createDeployment(project.id);
  try {
    await appendLog({
      deploymentId: dep.id,
      projectId: project.id,
      source: "git",
      level: "info",
      message: "cloning repository",
    });
    await appendLog({
      deploymentId: dep.id,
      projectId: project.id,
      source: "build",
      level: "info",
      message: "build started",
    });
    await appendLog({
      deploymentId: dep.id,
      projectId: project.id,
      source: "build",
      level: "error",
      message: "build failed: boom",
    });

    const page1 = await listLogs({ deploymentId: dep.id, limit: 2, direction: "asc" });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.next_cursor);
    assert.equal(page1.items[0].source, "git");

    const page2 = await listLogs({
      deploymentId: dep.id,
      cursor: Number(page1.next_cursor),
      limit: 10,
      direction: "asc",
    });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.next_cursor, null);

    const builds = await listLogs({ deploymentId: dep.id, source: "build", limit: 10 });
    assert.equal(builds.items.length, 2);
    const errors = await listLogs({ deploymentId: dep.id, level: "error", limit: 10 });
    assert.equal(errors.items.length, 1);

    // Descending order is stable by id.
    const desc = await listLogs({ deploymentId: dep.id, limit: 10, direction: "desc" });
    assert.equal(desc.items[0].message, "build failed: boom");

    // Secret metadata keys are redacted; tokens in messages are redacted.
    const secretRow = await appendLog({
      deploymentId: dep.id,
      projectId: project.id,
      source: "system",
      level: "info",
      message: "using bearer secrettoken123",
      metadata: { github_token: "ghp_xyz", attempt: 1 },
    });
    assert.equal(secretRow.metadata.github_token, "[redacted]");
    assert.ok(!(secretRow.message as string).includes("secrettoken123"));

    const usage = await getDeploymentLogUsage(dep.id);
    assert.ok(usage.lines >= 4);
    assert.equal(usage.truncated, false);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("appendOutput splits bulk output into bounded lines", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`logs-bulk-${Date.now()}`);
  const dep = await createDeployment(project.id);
  try {
    const written = await appendOutput({
      deploymentId: dep.id,
      projectId: project.id,
      source: "build",
      level: "info",
      output: "line one\n\nline two\r\n\x1b[32mline three\x1b[0m\n",
    });
    assert.equal(written, 3);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("safeAppendLog never throws on validation failure", async () => {
  const row = await safeAppendLog({
    deploymentId: "not-a-uuid",
    projectId: "also-bad",
    source: "build",
    level: "info",
    message: "hi",
  });
  assert.equal(row, null);
});

test("deleteExpiredLogs removes only rows past retention", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`logs-ret-${Date.now()}`);
  const dep = await createDeployment(project.id);
  try {
    await appendLog({
      deploymentId: dep.id,
      projectId: project.id,
      source: "system",
      level: "info",
      message: "old log",
    });
    await pool.query(
      `UPDATE deployment_logs SET created_at = NOW() - INTERVAL '400 days' WHERE deployment_id = $1`,
      [dep.id]
    );
    const deleted = await deleteExpiredLogs();
    assert.ok(deleted >= 1);
    const remaining = await listLogs({ deploymentId: dep.id, limit: 10 });
    assert.equal(remaining.items.length, 0);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});
