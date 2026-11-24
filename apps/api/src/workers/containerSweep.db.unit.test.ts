import test from "node:test";
import assert from "node:assert/strict";
import "../test/testEnv.js";
import pool from "../db/database.js";
import { gateDb } from "../test/dbGate.js";
import {
  classifyContainer,
  sweepUnactivatedContainers,
  type DiscoveredContainer,
} from "./containerSweep.js";
import {
  ADVISORY_LOCK_NAMESPACES,
  tryAcquireSessionAdvisoryLock,
  releaseSessionAdvisoryLock,
} from "../db/advisoryLock.js";
import type { ExecResult } from "../infrastructure/process/dockerExec.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

function mockExecOk(stdout = "", stderr = ""): ExecResult {
  return { code: 0, stdout, stderr, timedOut: false, aborted: false };
}

test("containerSweep: real database classification of active, failed, cancelled, and foreign containers", async () => {
  if (!(await gateDb("workers/containerSweep.db.unit.test.ts", dbAvailable))) return;

  const projectId = "11111111-2222-3333-4444-555555555555";
  const depActive = "22222222-1111-1111-1111-111111111111";
  const depFailed = "33333333-1111-1111-1111-111111111111";
  const depCancelled = "44444444-1111-1111-1111-111111111111";

  const nameActive = `dk-p11111111-d22222222`;
  const nameFailed = `dk-p11111111-d33333333`;
  const nameCancelled = `dk-p11111111-d44444444`;
  const nameForeign = `dk-p99999999-d88888888`;

  const now = Date.now();
  const oldTime = now - 600_000; // 10 minutes old

  try {
    await pool.query(
      `INSERT INTO projects (id, name, repository_url, branch)
       VALUES ($1, 'sweep-test-proj', 'https://github.com/test/repo', 'main')
       ON CONFLICT (id) DO NOTHING`,
      [projectId]
    );

    // 1. Active deployment & release
    await pool.query(
      `INSERT INTO deployments (id, project_id, trigger, status, branch)
       VALUES ($1, $2, 'manual', 'active', 'main')
       ON CONFLICT (id) DO NOTHING`,
      [depActive, projectId]
    );
    const relActive = await pool.query(
      `INSERT INTO releases (deployment_id, project_id, image_repository, image_digest, commit_sha, branch, status, created_at, activated_at)
       VALUES ($1, $2, 'test/img', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'main', 'active', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '4 minutes')
       RETURNING id`,
      [depActive, projectId]
    );
    await pool.query(
      `INSERT INTO runtime_instances (release_id, status, container_name, container_port, host_port)
       VALUES ($1, 'running', $2, 3000, 3001)
       ON CONFLICT (container_name) DO NOTHING`,
      [relActive.rows[0].id, nameActive]
    );

    // 2. Failed deployment
    await pool.query(
      `INSERT INTO deployments (id, project_id, trigger, status, branch)
       VALUES ($1, $2, 'manual', 'failed', 'main')
       ON CONFLICT (id) DO NOTHING`,
      [depFailed, projectId]
    );
    const relFailed = await pool.query(
      `INSERT INTO releases (deployment_id, project_id, image_repository, image_digest, commit_sha, branch, status, created_at)
       VALUES ($1, $2, 'test/img', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'main', 'failed', NOW() - INTERVAL '6 minutes')
       RETURNING id`,
      [depFailed, projectId]
    );
    await pool.query(
      `INSERT INTO runtime_instances (release_id, status, container_name, container_port, host_port)
       VALUES ($1, 'failed', $2, 3000, 3002)
       ON CONFLICT (container_name) DO NOTHING`,
      [relFailed.rows[0].id, nameFailed]
    );

    // 3. Cancelled deployment
    await pool.query(
      `INSERT INTO deployments (id, project_id, trigger, status, branch)
       VALUES ($1, $2, 'manual', 'cancelled', 'main')
       ON CONFLICT (id) DO NOTHING`,
      [depCancelled, projectId]
    );

    // Verify Active Release is Protected
    const cActive: DiscoveredContainer = {
      name: nameActive,
      state: "running",
      createdAtMs: oldTime,
      id: "cid-active",
      projectPrefix: "11111111",
      deploymentPrefix: "22222222",
    };
    const decisionActive = await classifyContainer(cActive, pool, now, 300_000);
    assert.equal(decisionActive.action, "protect");
    assert.equal(decisionActive.reason, "active_release");

    // Verify Failed Deployment is Swept
    const cFailed: DiscoveredContainer = {
      name: nameFailed,
      state: "exited",
      createdAtMs: oldTime,
      id: "cid-failed",
      projectPrefix: "11111111",
      deploymentPrefix: "33333333",
    };
    const decisionFailed = await classifyContainer(cFailed, pool, now, 300_000);
    assert.equal(decisionFailed.action, "sweep");
    assert.equal(decisionFailed.reason, "release_failed");

    // Verify Cancelled Deployment is Swept
    const cCancelled: DiscoveredContainer = {
      name: nameCancelled,
      state: "exited",
      createdAtMs: oldTime,
      id: "cid-cancelled",
      projectPrefix: "11111111",
      deploymentPrefix: "44444444",
    };
    const decisionCancelled = await classifyContainer(cCancelled, pool, now, 300_000);
    assert.equal(decisionCancelled.action, "sweep");
    assert.equal(decisionCancelled.reason, "deployment_cancelled");

    // Verify Foreign Container is Protected
    const cForeign: DiscoveredContainer = {
      name: nameForeign,
      state: "running",
      createdAtMs: oldTime,
      id: "cid-foreign",
      projectPrefix: "99999999",
      deploymentPrefix: "88888888",
    };
    const decisionForeign = await classifyContainer(cForeign, pool, now, 300_000);
    assert.equal(decisionForeign.action, "protect");
    assert.equal(decisionForeign.reason, "foreign_installation");
  } finally {
    await pool.query(`DELETE FROM runtime_instances WHERE container_name IN ($1, $2, $3)`, [nameActive, nameFailed, nameCancelled]);
    await pool.query(`DELETE FROM releases WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM deployments WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  }
});

test("containerSweep: real database advisory lock mutual exclusion between concurrent workers", async () => {
  if (!(await gateDb("workers/containerSweep.db.unit.test.ts", dbAvailable))) return;

  const client1 = await pool.connect();
  const sweepLockKey = "worker-container-sweep";

  try {
    // 1. Worker 1 acquires lock on client 1
    const acquired = await tryAcquireSessionAdvisoryLock(
      client1,
      ADVISORY_LOCK_NAMESPACES.CONTAINER_SWEEP,
      sweepLockKey
    );
    assert.equal(acquired, true, "Worker 1 should acquire advisory lock");

    // 2. Worker 2 calls sweepUnactivatedContainers -> must return locked: true
    const summaryLocked = await sweepUnactivatedContainers({ pool });
    assert.equal(summaryLocked.locked, true);
    assert.equal(summaryLocked.swept, 0);

    // 3. Worker 1 releases lock
    await releaseSessionAdvisoryLock(
      client1,
      ADVISORY_LOCK_NAMESPACES.CONTAINER_SWEEP,
      sweepLockKey
    );

    // 4. Worker 2 can now run without being locked
    const summaryFree = await sweepUnactivatedContainers({
      pool,
      runFn: (async () => mockExecOk("")) as any,
    });
    assert.equal(summaryFree.locked, false);
  } finally {
    client1.release();
  }
});

test("containerSweep: real database updates runtime_instances to stopped after removal", async () => {
  if (!(await gateDb("workers/containerSweep.db.unit.test.ts", dbAvailable))) return;

  const projectId = "11111111-3333-4444-5555-666666666666";
  const depId = "22222222-3333-4444-5555-666666666666";
  const containerName = "dk-p11111111-d22222222";

  try {
    await pool.query(
      `INSERT INTO projects (id, name, repository_url, branch)
       VALUES ($1, 'sweep-update-proj', 'https://github.com/test/repo', 'main')
       ON CONFLICT (id) DO NOTHING`,
      [projectId]
    );
    await pool.query(
      `INSERT INTO deployments (id, project_id, trigger, status, branch)
       VALUES ($1, $2, 'manual', 'failed', 'main')
       ON CONFLICT (id) DO NOTHING`,
      [depId, projectId]
    );
    const rel = await pool.query(
      `INSERT INTO releases (deployment_id, project_id, image_repository, image_digest, commit_sha, branch, status, created_at)
       VALUES ($1, $2, 'test/img', 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'cccccccccccccccccccccccccccccccccccccccc', 'main', 'failed', NOW() - INTERVAL '6 minutes')
       RETURNING id`,
      [depId, projectId]
    );
    await pool.query(
      `INSERT INTO runtime_instances (release_id, status, container_name, container_port, host_port)
       VALUES ($1, 'starting', $2, 3000, 3003)
       ON CONFLICT (container_name) DO NOTHING`,
      [rel.rows[0].id, containerName]
    );

    const dockerLs = `${containerName}\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-update\n`;
    const runFn = async (binary: string, args: string[]) => {
      if (args[0] === "container" && args[1] === "ls") return mockExecOk(dockerLs);
      if (args[0] === "container" && args[1] === "rm") return mockExecOk();
      return mockExecOk();
    };

    const summary = await sweepUnactivatedContainers({
      pool,
      runFn: runFn as any,
      now: () => Date.now() + 600_000,
    });

    assert.equal(summary.swept, 1);
    assert.equal(summary.errors, 0);

    const updated = await pool.query(
      `SELECT status, stopped_at FROM runtime_instances WHERE container_name = $1`,
      [containerName]
    );
    assert.equal(updated.rows[0]?.status, "stopped");
    assert.ok(updated.rows[0]?.stopped_at !== null, "stopped_at must be populated");
  } finally {
    await pool.query(`DELETE FROM runtime_instances WHERE container_name = $1`, [containerName]);
    await pool.query(`DELETE FROM releases WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM deployments WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  }
});
