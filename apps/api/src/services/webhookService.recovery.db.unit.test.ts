import test from "node:test";
import assert from "node:assert/strict";
import pool from "../db/database.js";
import { handleGitHubWebhook } from "./webhookService.js";
import { linkProjectRepository } from "./githubLinkService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    const check = await pool.query(
      `SELECT to_regclass('public.github_webhook_deliveries') AS c`
    );
    if (check.rows[0].c === null) return false;
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'github_webhook_deliveries' AND column_name = 'updated_at'`
    );
    return cols.rowCount === 1;
  } catch {
    return false;
  }
}

const SHA = "e".repeat(40);

async function createProject(name: string, branch = "main") {
  return (
    await pool.query(
      `INSERT INTO projects (name, repository_url, branch)
       VALUES ($1, 'https://github.com/acme/app.git', $2) RETURNING *`,
      [name, branch]
    )
  ).rows[0];
}

function pushBody(fullName: string, branch: string, sha: string, installation = 777): Buffer {
  return Buffer.from(
    JSON.stringify({
      ref: `refs/heads/${branch}`,
      after: sha,
      deleted: false,
      repository: { full_name: fullName, id: 1 },
      installation: { id: installation },
    })
  );
}

async function deploymentCount(deliveryId: string): Promise<number> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM deployments WHERE idempotency_key = $1`,
    [`github:${deliveryId}`]
  );
  return r.rows[0].n;
}

async function cleanup(projectIds: string[]): Promise<void> {
  for (const id of projectIds) {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [id]);
  }
  await pool.query(`DELETE FROM github_webhook_deliveries WHERE delivery_id LIKE 'r-%'`);
  await pool.query(`DELETE FROM projects WHERE name LIKE 'whrec-%'`);
}

test("concurrent duplicate deliveries create exactly one deployment", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`whrec-conc-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: project.id,
      installationId: "777",
      repositoryFullName: "acme/rec-conc",
      autoDeploy: true,
    });
    const deliveryId = `r-${Date.now()}-conc`;
    const body = pushBody("acme/rec-conc", "main", SHA);
    const [a, b] = await Promise.all([
      handleGitHubWebhook({ deliveryId, event: "push", rawBody: body }),
      handleGitHubWebhook({ deliveryId, event: "push", rawBody: body }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, ["duplicate", "processed"]);
    assert.equal(await deploymentCount(deliveryId), 1);
  } finally {
    await cleanup([project.id]);
  }
});

test("crashed delivery (persisted, never processed) resumes on redelivery", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`whrec-crash-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: project.id,
      installationId: "777",
      repositoryFullName: "acme/rec-crash",
      autoDeploy: true,
    });
    const deliveryId = `r-${Date.now()}-crash`;
    // Simulate crash: row persisted as received, handler died before processing.
    await pool.query(
      `INSERT INTO github_webhook_deliveries (delivery_id, event_type, status, attempts)
       VALUES ($1, 'push', 'received', 0)`,
      [deliveryId]
    );
    const outcome = await handleGitHubWebhook({
      deliveryId,
      event: "push",
      rawBody: pushBody("acme/rec-crash", "main", SHA),
    });
    assert.equal(outcome.status, "processed");
    assert.equal(await deploymentCount(deliveryId), 1);
    const row = (
      await pool.query(
        `SELECT status, attempts FROM github_webhook_deliveries WHERE delivery_id = $1`,
        [deliveryId]
      )
    ).rows[0];
    assert.equal(row.status, "processed");
    assert.ok(row.attempts >= 1);
  } finally {
    await cleanup([project.id]);
  }
});

test("failed delivery can resume and succeed later", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`whrec-fail-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: project.id,
      installationId: "777",
      repositoryFullName: "acme/rec-fail",
      autoDeploy: true,
    });
    const deliveryId = `r-${Date.now()}-fail`;
    await pool.query(
      `INSERT INTO github_webhook_deliveries (delivery_id, event_type, status, attempts, error)
       VALUES ($1, 'push', 'failed', 1, 'simulated deployment DB outage')`,
      [deliveryId]
    );
    const outcome = await handleGitHubWebhook({
      deliveryId,
      event: "push",
      rawBody: pushBody("acme/rec-fail", "main", SHA),
    });
    assert.equal(outcome.status, "processed");
    assert.equal(await deploymentCount(deliveryId), 1);
  } finally {
    await cleanup([project.id]);
  }
});

test("already-processed delivery returns duplicate without new deployment", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`whrec-done-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: project.id,
      installationId: "777",
      repositoryFullName: "acme/rec-done",
      autoDeploy: true,
    });
    const deliveryId = `r-${Date.now()}-done`;
    const first = await handleGitHubWebhook({
      deliveryId,
      event: "push",
      rawBody: pushBody("acme/rec-done", "main", SHA),
    });
    assert.equal(first.status, "processed");
    const before = await deploymentCount(deliveryId);
    const second = await handleGitHubWebhook({
      deliveryId,
      event: "push",
      rawBody: pushBody("acme/rec-done", "main", SHA),
    });
    assert.equal(second.status, "duplicate");
    assert.equal(await deploymentCount(deliveryId), before);
  } finally {
    await cleanup([project.id]);
  }
});

test("stale processing lease is reclaimed; fresh lease is respected", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`whrec-lease-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: project.id,
      installationId: "777",
      repositoryFullName: "acme/rec-lease",
      autoDeploy: true,
    });
    const staleId = `r-${Date.now()}-stale`;
    await pool.query(
      `INSERT INTO github_webhook_deliveries (delivery_id, event_type, status, attempts, updated_at)
       VALUES ($1, 'push', 'processing', 1, CURRENT_TIMESTAMP - INTERVAL '10 minutes')`,
      [staleId]
    );
    const reclaimed = await handleGitHubWebhook({
      deliveryId: staleId,
      event: "push",
      rawBody: pushBody("acme/rec-lease", "main", SHA),
    });
    assert.equal(reclaimed.status, "processed");
    assert.equal(await deploymentCount(staleId), 1);

    const liveId = `r-${Date.now()}-live`;
    await pool.query(
      `INSERT INTO github_webhook_deliveries (delivery_id, event_type, status, attempts, updated_at)
       VALUES ($1, 'push', 'processing', 1, CURRENT_TIMESTAMP)`,
      [liveId]
    );
    const duplicate = await handleGitHubWebhook({
      deliveryId: liveId,
      event: "push",
      rawBody: pushBody("acme/rec-lease", "main", SHA),
    });
    assert.equal(duplicate.status, "duplicate");
    assert.equal(await deploymentCount(liveId), 0);
  } finally {
    await cleanup([project.id]);
  }
});
