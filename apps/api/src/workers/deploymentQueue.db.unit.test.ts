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
  releaseJobLease,
} from "./deploymentQueue.js";
import { gateDb } from "../test/dbGate.js";

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
  if (!(await gateDb("workers/deploymentQueue.db.unit.test.ts", dbAvailable))) {
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
  if (!(await gateDb("workers/deploymentQueue.db.unit.test.ts", dbAvailable))) {
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
      claimed!.leaseToken,
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

test("failJob persists redacted error messages across all surfaces", async () => {
  if (!(await gateDb("workers/deploymentQueue.db.unit.test.ts", dbAvailable))) {
    return;
  }
  const project = await createProject(`redact-${Date.now()}`);
  try {
    const deployment = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    const claimed = await claimNextJob("test-worker-redact", 30_000);
    assert.ok(claimed);
    const secretMessage =
      "build output leaked: bearer super-secret-token-42 then ghp_secret1234567890 and password=hunter2-guess-it";
    const outcome = await failJob(
      claimed!.id,
      claimed!.deploymentId,
      "test-worker-redact",
      claimed!.leaseToken,
      secretMessage
    );
    assert.equal(outcome, "retrying");

    const job = await pool.query(
      `SELECT last_error FROM deployment_jobs WHERE id = $1`,
      [claimed!.id]
    );
    const dep = await pool.query(
      `SELECT error_message FROM deployments WHERE id = $1`,
      [deployment.id]
    );
    const events = await pool.query(
      `SELECT metadata FROM deployment_events
       WHERE deployment_id = $1 AND event_type = 'deployment.retry_scheduled'`,
      [deployment.id]
    );
    const attempts = await pool.query(
      `SELECT error_message FROM deployment_attempts
       WHERE deployment_id = $1 AND attempt_number = 1`,
      [deployment.id]
    );

    const surfaces: Array<[string, unknown]> = [
      ["deployment_jobs.last_error", job.rows[0]?.last_error],
      ["deployments.error_message", dep.rows[0]?.error_message],
      ["deployment_events.metadata", JSON.stringify(events.rows[0]?.metadata ?? null)],
      ["deployment_attempts.error_message", attempts.rows[0]?.error_message],
    ];

    for (const [label, raw] of surfaces) {
      const text = typeof raw === "string" ? raw : "";
      assert.ok(text.length > 0, `${label} should record an error`);
      assert.ok(!text.includes("super-secret-token-42"), `${label} must not leak the bearer token`);
      assert.ok(!text.includes("ghp_secret1234567890"), `${label} must not leak the GitHub token`);
      assert.ok(!text.includes("hunter2-guess-it"), `${label} must not leak the password value`);
      assert.ok(text.includes("[redacted]"), `${label} should carry redaction markers`);
    }
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("expired leases are recovered with audit events", async () => {
  if (!(await gateDb("workers/deploymentQueue.db.unit.test.ts", dbAvailable))) {
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
  if (!(await gateDb("workers/deploymentQueue.db.unit.test.ts", dbAvailable))) {
    return;
  }
  const { createAgent } = await import("../agents/agentService.js");
  const { claimAgentJob } = await import("../agents/agentJobService.js");
  const project = await createProject(`edge-isolation-${Date.now()}`);
  const centralProject = await createProject(`edge-isolation-central-${Date.now()}`);
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
      projectId: centralProject.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    assert.ok(centralDeployment);

    const claimed = await claimNextJob("central-iso-probe", 30_000);
    assert.ok(claimed);
    assert.equal(claimed?.deploymentId, centralDeployment.id);

    await failJob(claimed!.id, claimed!.deploymentId, "central-iso-probe", claimed!.leaseToken, "release central job");
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
    await pool.query(`DELETE FROM projects WHERE id = $1`, [centralProject.id]);
  }
});

test("an expired edge lease is never stolen by the central worker", async () => {
  if (!(await gateDb("workers/deploymentQueue.db.unit.test.ts", dbAvailable))) {
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

test("releasing a lease requeues the job immediately and clears the lease", async () => {
  if (!(await gateDb("workers/deploymentQueue.db.unit.test.ts", dbAvailable))) {
    return;
  }
  const project = await createProject(`release-${Date.now()}`);
  try {
    const deployment = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    const claimed = await claimNextJob("release-worker", 30_000);
    assert.ok(claimed);
    assert.equal(claimed?.deploymentId, deployment.id);

    const released = await releaseJobLease(
      claimed!.id,
      deployment.id,
      "release-worker",
      claimed!.leaseToken,
      "Worker is shutting down"
    );
    assert.equal(released, true);

    const job = await pool.query(
      `SELECT status, locked_by, lease_expires_at, lease_token FROM deployment_jobs WHERE id = $1`,
      [claimed!.id]
    );
    assert.equal(job.rows[0].status, "queued");
    assert.equal(job.rows[0].locked_by, null);
    assert.equal(job.rows[0].lease_expires_at, null);
    assert.equal(job.rows[0].lease_token, null);

    const dep = await pool.query(
      `SELECT status, error_code FROM deployments WHERE id = $1`,
      [deployment.id]
    );
    assert.equal(dep.rows[0].status, "queued");
    assert.equal(dep.rows[0].error_code, "WORKER_LEASE_RELEASED");

    const events = await pool.query(
      `SELECT event_type FROM deployment_events WHERE deployment_id = $1 AND event_type = 'deployment.lease_released'`,
      [deployment.id]
    );
    assert.equal(events.rowCount, 1);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("a stale lease token cannot release a job that was taken over", async () => {
  if (!(await gateDb("workers/deploymentQueue.db.unit.test.ts", dbAvailable))) {
    return;
  }
  const project = await createProject(`release-fence-${Date.now()}`);
  try {
    const deployment = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    const claimed = await claimNextJob("fence-worker", 30_000);
    assert.ok(claimed);

    const released = await releaseJobLease(
      claimed!.id,
      deployment.id,
      "fence-worker",
      "99999999-9999-9999-9999-999999999999",
      "stale token"
    );
    assert.equal(released, false, "a stale lease token must not release the job");

    const job = await pool.query(
      `SELECT status, locked_by FROM deployment_jobs WHERE id = $1`,
      [claimed!.id]
    );
    assert.equal(job.rows[0].status, "running");
    assert.equal(job.rows[0].locked_by, "fence-worker");
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("a queued follow-up job is not claimed while the project already has a running job", async () => {
  if (!(await gateDb("workers/deploymentQueue.db.unit.test.ts", dbAvailable))) {
    return;
  }
  const project = await createProject(`serialize-${Date.now()}`);
  try {
    const first = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    const claimed = await claimNextJob("serialize-worker", 30_000);
    assert.ok(claimed);
    assert.equal(claimed?.deploymentId, first.id);

    const second = await createDeployment({
      projectId: project.id,
      trigger: "github_push",
      idempotencyKey: `serialize-${Date.now()}`,
      deferWhenBusy: true,
    });
    assert.ok(second, "a follow-up deployment must be queued, not rejected");

    const next = await claimNextJob("serialize-worker-2", 30_000);
    assert.equal(
      next?.deploymentId,
      undefined,
      "the worker must not run two deployments of the same project concurrently"
    );

    const queued = await pool.query(
      `SELECT status FROM deployment_jobs WHERE deployment_id = $1`,
      [second.id]
    );
    assert.equal(queued.rows[0].status, "queued");
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});
