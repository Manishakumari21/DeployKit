import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import {
  appendLog,
  appendLogs,
  appendOutput,
  deleteExpiredLogs,
  deploymentUsage,
  getDeploymentLogUsage,
  listLogs,
  normalizeLogLine,
  redactSecrets,
  safeAppendLog,
  safeAppendLogs,
} from "./deploymentLogService.js";
import { gateDb } from "../test/dbGate.js";

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
  if (!(await gateDb("services/deploymentLogService.db.unit.test.ts", dbAvailable))) return;
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

    const desc = await listLogs({ deploymentId: dep.id, limit: 10, direction: "desc" });
    assert.equal(desc.items[0].message, "build failed: boom");

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
  if (!(await gateDb("services/deploymentLogService.db.unit.test.ts", dbAvailable))) return;
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
  if (!(await gateDb("services/deploymentLogService.db.unit.test.ts", dbAvailable))) return;
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

test("appendLogs ingests large batches (150 lines) in a single batch operation", async () => {
  if (!(await gateDb("services/deploymentLogService.db.unit.test.ts", dbAvailable))) return;
  const project = await createProject(`logs-batch-${Date.now()}`);
  const dep = await createDeployment(project.id);
  try {
    const inputs = Array.from({ length: 150 }, (_, i) => ({
      deploymentId: dep.id,
      projectId: project.id,
      source: "build" as const,
      level: "info" as const,
      message: `build step output line #${i + 1}`,
      metadata: { stepIndex: i + 1 },
    }));

    const rows = await appendLogs(inputs);
    assert.equal(rows.length, 150);
    assert.equal(rows[0].message, "build step output line #1");
    assert.equal(rows[149].message, "build step output line #150");

    const usage = await getDeploymentLogUsage(dep.id);
    assert.equal(usage.lines, 150);
    assert.equal(usage.truncated, false);

    const logs = await listLogs({ deploymentId: dep.id, limit: 200, direction: "asc" });
    assert.equal(logs.items.length, 150);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("appendLogs enforces line quota and inserts truncation marker exactly once", async () => {
  if (!(await gateDb("services/deploymentLogService.db.unit.test.ts", dbAvailable))) return;
  const origMax = process.env.DEPLOYKIT_LOG_MAX_LINES_PER_DEPLOYMENT;
  process.env.DEPLOYKIT_LOG_MAX_LINES_PER_DEPLOYMENT = "5";
  const project = await createProject(`logs-quota-${Date.now()}`);
  const dep = await createDeployment(project.id);
  try {
    const inputs = Array.from({ length: 8 }, (_, i) => ({
      deploymentId: dep.id,
      projectId: project.id,
      source: "build" as const,
      level: "info" as const,
      message: `quota line ${i + 1}`,
    }));

    const rows = await appendLogs(inputs);
    // 5 log rows + 1 truncation row
    assert.equal(rows.length, 6);
    assert.equal(rows[5].level, "warn");
    assert.equal(rows[5].message, "Log output truncated: deployment limit reached");
    assert.equal(rows[5].metadata?.reason, "deployment_limit");

    const usage = await getDeploymentLogUsage(dep.id);
    assert.equal(usage.lines, 6);
    assert.equal(usage.truncated, true);

    // Subsequent ingestion attempts must return the existing marker row and insert nothing new
    const subsequent = await appendLogs([
      {
        deploymentId: dep.id,
        projectId: project.id,
        source: "build",
        level: "info",
        message: "this should be rejected due to limit",
      },
    ]);
    assert.equal(subsequent.length, 1);
    assert.equal(subsequent[0].metadata?.reason, "deployment_limit");

    const usageAfter = await getDeploymentLogUsage(dep.id);
    assert.equal(usageAfter.lines, 6); // count unchanged
  } finally {
    if (origMax !== undefined) {
      process.env.DEPLOYKIT_LOG_MAX_LINES_PER_DEPLOYMENT = origMax;
    } else {
      delete process.env.DEPLOYKIT_LOG_MAX_LINES_PER_DEPLOYMENT;
    }
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("appendLogs enforces byte quota and gracefully truncates", async () => {
  if (!(await gateDb("services/deploymentLogService.db.unit.test.ts", dbAvailable))) return;
  const origMax = process.env.DEPLOYKIT_LOG_MAX_BYTES_PER_DEPLOYMENT;
  process.env.DEPLOYKIT_LOG_MAX_BYTES_PER_DEPLOYMENT = "100";
  const project = await createProject(`logs-bytes-${Date.now()}`);
  const dep = await createDeployment(project.id);
  try {
    // Each line is ~40 bytes
    const inputs = [
      {
        deploymentId: dep.id,
        projectId: project.id,
        source: "build" as const,
        level: "info" as const,
        message: "A".repeat(40),
      },
      {
        deploymentId: dep.id,
        projectId: project.id,
        source: "build" as const,
        level: "info" as const,
        message: "B".repeat(40),
      },
      {
        deploymentId: dep.id,
        projectId: project.id,
        source: "build" as const,
        level: "info" as const,
        message: "C".repeat(40),
      },
    ];

    const rows = await appendLogs(inputs);
    // Line 1 (40B) and Line 2 (40B) fit into 100B. Line 3 (40B) exceeds 100B, triggering truncation marker.
    assert.equal(rows.length, 3); // 2 rows + 1 marker row
    assert.equal(rows[2].metadata?.reason, "deployment_limit");

    const usage = await getDeploymentLogUsage(dep.id);
    assert.equal(usage.truncated, true);
  } finally {
    if (origMax !== undefined) {
      process.env.DEPLOYKIT_LOG_MAX_BYTES_PER_DEPLOYMENT = origMax;
    } else {
      delete process.env.DEPLOYKIT_LOG_MAX_BYTES_PER_DEPLOYMENT;
    }
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("concurrent appendLogs for same deployment serialize cleanly under advisory lock", async () => {
  if (!(await gateDb("services/deploymentLogService.db.unit.test.ts", dbAvailable))) return;
  const project = await createProject(`logs-conc-${Date.now()}`);
  const dep = await createDeployment(project.id);
  try {
    // 5 concurrent batches of 20 items each
    const batches = Array.from({ length: 5 }, (_, batchIdx) =>
      Array.from({ length: 20 }, (_, itemIdx) => ({
        deploymentId: dep.id,
        projectId: project.id,
        source: "build" as const,
        level: "info" as const,
        message: `batch ${batchIdx} item ${itemIdx}`,
      }))
    );

    const results = await Promise.all(batches.map((b) => appendLogs(b)));
    assert.equal(results.length, 5);
    for (const r of results) {
      assert.equal(r.length, 20);
    }

    const usage = await getDeploymentLogUsage(dep.id);
    assert.equal(usage.lines, 100);
    assert.equal(usage.truncated, false);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("appendLogs transaction rolls back on invalid input mid-batch", async () => {
  if (!(await gateDb("services/deploymentLogService.db.unit.test.ts", dbAvailable))) return;
  const project = await createProject(`logs-rollback-${Date.now()}`);
  const dep = await createDeployment(project.id);
  try {
    // An input that passes validateAppendInput (non-empty string),
    // but normalizeLogLine strips ANSI to empty string, causing transaction to fail and rollback.
    const inputs = [
      {
        deploymentId: dep.id,
        projectId: project.id,
        source: "build" as const,
        level: "info" as const,
        message: "valid line 1",
      },
      {
        deploymentId: dep.id,
        projectId: project.id,
        source: "build" as const,
        level: "info" as const,
        message: " \x1b[32m\x1b[0m ", // normalizes to empty string
      },
    ];

    await assert.rejects(
      () => appendLogs(inputs),
      /Log message must not be empty/
    );

    // Verify atomic rollback: valid line 1 must NOT be in DB
    const usage = await getDeploymentLogUsage(dep.id);
    assert.equal(usage.lines, 0);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

