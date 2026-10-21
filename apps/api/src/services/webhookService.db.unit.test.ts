import test from "node:test";
import assert from "node:assert/strict";
import pool from "../db/database.js";
import { handleGitHubWebhook, WebhookError } from "./webhookService.js";
import { linkProjectRepository } from "./githubLinkService.js";
import { gateDb } from "../test/dbGate.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    const check = await pool.query(`SELECT to_regclass('public.github_webhook_deliveries') AS c`);
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

const SHA_A = "c".repeat(40);
const SHA_B = "d".repeat(40);

async function createProject(name: string, branch = "main") {
  const result = await pool.query(
    `INSERT INTO projects (name, repository_url, branch) VALUES ($1, 'https://github.com/acme/app.git', $2) RETURNING *`,
    [name, branch]
  );
  return result.rows[0];
}

function pushBody(fullName: string, branch: string, sha: string, installation = 555): Buffer {
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

async function cleanup(projectId?: string): Promise<void> {
  if (projectId) await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM github_webhook_deliveries WHERE delivery_id LIKE 't-%'`);
  await pool.query(`DELETE FROM projects WHERE name LIKE 'wh-%'`);
}

test("push to a linked repo creates a github_push deployment with exact SHA", async () => {
  if (!(await gateDb("services/webhookService.db.unit.test.ts", dbAvailable))) return;
  const project = await createProject(`wh-link-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: project.id,
      installationId: "555",
      repositoryFullName: "acme/linked-app",
      autoDeploy: true,
    });
    const outcome = await handleGitHubWebhook({
      deliveryId: `t-${Date.now()}-a`,
      event: "push",
      rawBody: pushBody("acme/linked-app", "main", SHA_A),
    });
    assert.equal(outcome.status, "processed");
    const depId = (outcome as { deploymentId: string }).deploymentId;
    const row = (await pool.query(`SELECT trigger, commit_sha, branch FROM deployments WHERE id = $1`, [depId])).rows[0];
    assert.equal(row.trigger, "github_push");
    assert.equal(row.commit_sha, SHA_A);
    assert.equal(row.branch, "main");
  } finally {
    await cleanup(project.id);
  }
});

test("repeat delivery does not create a duplicate deployment", async () => {
  if (!(await gateDb("services/webhookService.db.unit.test.ts", dbAvailable))) return;
  const project = await createProject(`wh-dedup-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: project.id,
      installationId: "555",
      repositoryFullName: "acme/dedup-app",
      autoDeploy: true,
    });
    const deliveryId = `t-${Date.now()}-dup`;
    const first = await handleGitHubWebhook({
      deliveryId,
      event: "push",
      rawBody: pushBody("acme/dedup-app", "main", SHA_B),
    });
    assert.equal(first.status, "processed");
    const second = await handleGitHubWebhook({
      deliveryId,
      event: "push",
      rawBody: pushBody("acme/dedup-app", "main", SHA_B),
    });
    assert.equal(second.status, "duplicate");
    const count = (
      await pool.query(`SELECT COUNT(*)::int AS n FROM deployments WHERE idempotency_key = $1`, [
        `github:${deliveryId}`,
      ])
    ).rows[0].n;
    assert.equal(count, 1);
  } finally {
    await cleanup(project.id);
  }
});

test("wrong branch, disabled auto_deploy, and unlinked repos are ignored", async () => {
  if (!(await gateDb("services/webhookService.db.unit.test.ts", dbAvailable))) return;
  const project = await createProject(`wh-branch-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: project.id,
      installationId: "555",
      repositoryFullName: "acme/branch-app",
      autoDeploy: true,
    });
    const wrong = await handleGitHubWebhook({
      deliveryId: `t-${Date.now()}-wb`,
      event: "push",
      rawBody: pushBody("acme/branch-app", "feature", SHA_A),
    });
    assert.equal(wrong.status, "ignored");

    await pool.query(`UPDATE projects SET auto_deploy = false WHERE id = $1`, [project.id]);
    const disabled = await handleGitHubWebhook({
      deliveryId: `t-${Date.now()}-off`,
      event: "push",
      rawBody: pushBody("acme/branch-app", "main", SHA_A),
    });
    assert.equal(disabled.status, "ignored");

    const unlinked = await handleGitHubWebhook({
      deliveryId: `t-${Date.now()}-un`,
      event: "push",
      rawBody: pushBody("acme/never-linked", "main", SHA_A),
    });
    assert.equal(unlinked.status, "ignored");
    assert.equal((unlinked as { reason: string }).reason, "repository_not_linked");
  } finally {
    await cleanup(project.id);
  }
});

test("unsupported events are ignored and bad SHAs rejected", async () => {
  if (!(await gateDb("services/webhookService.db.unit.test.ts", dbAvailable))) return;
  const ignored = await handleGitHubWebhook({
    deliveryId: `t-${Date.now()}-ping`,
    event: "ping",
    rawBody: Buffer.from(JSON.stringify({ zen: "hi" })),
  });
  assert.equal(ignored.status, "ignored");
  await assert.rejects(
    handleGitHubWebhook({
      deliveryId: `t-${Date.now()}-bad`,
      event: "push",
      rawBody: pushBody("acme/linked-app", "main", "short"),
    }),
    (error: unknown) => error instanceof WebhookError
  );
});

test("installation mismatch does not deploy", async () => {
  if (!(await gateDb("services/webhookService.db.unit.test.ts", dbAvailable))) return;
  const project = await createProject(`wh-inst-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: project.id,
      installationId: "555",
      repositoryFullName: "acme/inst-app",
      autoDeploy: true,
    });
    const outcome = await handleGitHubWebhook({
      deliveryId: `t-${Date.now()}-im`,
      event: "push",
      rawBody: pushBody("acme/inst-app", "main", SHA_A, 999),
    });
    assert.equal(outcome.status, "ignored");
  } finally {
    await cleanup(project.id);
  }
});

test("a push during a running deployment is queued instead of dropped", async () => {
  if (!(await gateDb("services/webhookService.db.unit.test.ts", dbAvailable))) return;
  const project = await createProject(`wh-busy-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: project.id,
      installationId: "555",
      repositoryFullName: "acme/busy-app",
      autoDeploy: true,
    });

    const running = await pool.query(
      `INSERT INTO deployments (project_id, status, trigger, branch, commit_sha)
       VALUES ($1, 'building', 'manual', 'main', $2) RETURNING *`,
      [project.id, SHA_A]
    );
    await pool.query(
      `INSERT INTO deployment_jobs (deployment_id, status, attempts, max_attempts)
       VALUES ($1, 'running', 1, 3)`,
      [running.rows[0].id]
    );

    const outcome = await handleGitHubWebhook({
      deliveryId: `t-${Date.now()}-busy`,
      event: "push",
      rawBody: pushBody("acme/busy-app", "main", SHA_B),
    });

    assert.equal(
      outcome.status,
      "processed",
      "a push must not be dropped while a deployment is running"
    );
    const deploymentId = (outcome as { deploymentId: string }).deploymentId;
    const row = (
      await pool.query(
        `SELECT status, trigger, commit_sha FROM deployments WHERE id = $1`,
        [deploymentId]
      )
    ).rows[0];
    assert.equal(row.status, "queued");
    assert.equal(row.trigger, "github_push");
    assert.equal(row.commit_sha, SHA_B);

    const job = await pool.query(
      `SELECT status FROM deployment_jobs WHERE deployment_id = $1`,
      [deploymentId]
    );
    assert.equal(job.rows[0].status, "queued");

    const delivery = await pool.query(
      `SELECT status FROM github_webhook_deliveries WHERE delivery_id LIKE 't-%' AND status = 'processed'`
    );
    assert.ok(
      (delivery.rowCount ?? 0) >= 1,
      "the delivery must be recorded as processed"
    );
  } finally {
    await cleanup(project.id);
  }
});

test("a manual deployment is still rejected while a deployment is in flight", async () => {
  if (!(await gateDb("services/webhookService.db.unit.test.ts", dbAvailable))) return;
  const project = await createProject(`wh-manual-${Date.now()}`);
  try {
    const running = await pool.query(
      `INSERT INTO deployments (project_id, status, trigger, branch, commit_sha)
       VALUES ($1, 'building', 'manual', 'main', $2) RETURNING *`,
      [project.id, SHA_A]
    );
    await pool.query(
      `INSERT INTO deployment_jobs (deployment_id, status, attempts, max_attempts)
       VALUES ($1, 'running', 1, 3)`,
      [running.rows[0].id]
    );

    const { createDeployment, DeploymentConflictError } = await import(
      "./deploymentService.js"
    );
    await assert.rejects(
      createDeployment({
        projectId: project.id,
        trigger: "manual",
        idempotencyKey: null,
      }),
      (error: unknown) => error instanceof DeploymentConflictError
    );
  } finally {
    await cleanup(project.id);
  }
});
