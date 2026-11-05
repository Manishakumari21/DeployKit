import test from "node:test";
import assert from "node:assert/strict";
import pool from "../db/database.js";
import { handleGitHubWebhook } from "./webhookService.js";
import { linkProjectRepository } from "./githubLinkService.js";
import { gateDb } from "../test/dbGate.js";
import { findPreviewProject, generatePreviewDomain } from "./previewService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    const check = await pool.query(`SELECT to_regclass('public.github_webhook_deliveries') AS c`);
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

// Fixture env restoration must delete undefined keys, not assign "undefined".
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** The feature is host-opt-in; every processed-path test flips it on. */
function enablePreviews(): string | undefined {
  const previous = process.env.DEPLOYKIT_PREVIEW_DEPLOYS;
  process.env.DEPLOYKIT_PREVIEW_DEPLOYS = "true";
  return previous;
}

const SHA_PR_1 = "1".repeat(40);
const SHA_PR_2 = "2".repeat(40);

async function createProject(name: string, branch = "main") {
  const result = await pool.query(
    `INSERT INTO projects (name, repository_url, branch, auto_deploy) VALUES ($1, 'https://github.com/acme/preview-app.git', $2, true) RETURNING *`,
    [name, branch]
  );
  return result.rows[0];
}

function prBody(options: {
  action: string;
  fullName: string;
  prNumber: number;
  headSha?: string;
  headRef?: string;
  baseRef?: string;
  installation?: number;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: options.action,
      number: options.prNumber,
      pull_request: {
        number: options.prNumber,
        head: {
          sha: options.headSha ?? SHA_PR_1,
          ref: options.headRef ?? "feature-test",
        },
        base: {
          ref: options.baseRef ?? "main",
        },
      },
      repository: { full_name: options.fullName, id: 101 },
      installation: { id: options.installation ?? 777 },
    })
  );
}

async function cleanup(parentId?: string): Promise<void> {
  if (parentId) {
    await pool.query(`DELETE FROM projects WHERE id = $1 OR parent_project_id = $1`, [parentId]);
  }
  await pool.query(`DELETE FROM github_webhook_deliveries WHERE delivery_id LIKE 'pr-del-%'`);
  await pool.query(`DELETE FROM projects WHERE name LIKE 'pr-proj-%'`);
}

test("pull_request opened creates shadow preview project and triggers deployment", async () => {
  if (!(await gateDb("services/previewDeployments.db.unit.test.ts", dbAvailable))) return;
  const previous = enablePreviews();
  const parent = await createProject(`pr-proj-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: parent.id,
      installationId: "777",
      repositoryFullName: "acme/preview-app",
      autoDeploy: true,
    });

    const deliveryId = `pr-del-${Date.now()}-open`;
    const outcome = await handleGitHubWebhook({
      deliveryId,
      event: "pull_request",
      rawBody: prBody({ action: "opened", fullName: "acme/preview-app", prNumber: 42, headSha: SHA_PR_1 }),
    });

    assert.equal(outcome.status, "processed");
    assert.ok(outcome.deploymentId);

    const preview = await findPreviewProject(parent.id, 42);
    assert.ok(preview);
    assert.equal(preview.is_preview, true);
    assert.equal(preview.parent_project_id, parent.id);
    assert.equal(preview.pr_number, 42);
    assert.equal(preview.branch, "feature-test");

    const dep = (await pool.query(`SELECT trigger, commit_sha, project_id FROM deployments WHERE id = $1`, [outcome.deploymentId])).rows[0];
    assert.equal(dep.trigger, "github_pull_request");
    assert.equal(dep.commit_sha, SHA_PR_1);
    assert.equal(dep.project_id, preview.id);
  } finally {
    restoreEnv("DEPLOYKIT_PREVIEW_DEPLOYS", previous);
    await cleanup(parent.id);
  }
});

test("pull_request synchronize updates shadow project branch and creates new deployment", async () => {
  if (!(await gateDb("services/previewDeployments.db.unit.test.ts", dbAvailable))) return;
  const previous = enablePreviews();
  const parent = await createProject(`pr-proj-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: parent.id,
      installationId: "777",
      repositoryFullName: "acme/preview-app-sync",
      autoDeploy: true,
    });

    // 1. Opened
    await handleGitHubWebhook({
      deliveryId: `pr-del-${Date.now()}-sync-1`,
      event: "pull_request",
      rawBody: prBody({ action: "opened", fullName: "acme/preview-app-sync", prNumber: 10, headSha: SHA_PR_1 }),
    });

    // 2. Synchronize with updated SHA
    const outcome = await handleGitHubWebhook({
      deliveryId: `pr-del-${Date.now()}-sync-2`,
      event: "pull_request",
      rawBody: prBody({ action: "synchronize", fullName: "acme/preview-app-sync", prNumber: 10, headSha: SHA_PR_2 }),
    });

    assert.equal(outcome.status, "processed");
    const dep = (await pool.query(`SELECT trigger, commit_sha FROM deployments WHERE id = $1`, [outcome.deploymentId])).rows[0];
    assert.equal(dep.trigger, "github_pull_request");
    assert.equal(dep.commit_sha, SHA_PR_2);
  } finally {
    restoreEnv("DEPLOYKIT_PREVIEW_DEPLOYS", previous);
    await cleanup(parent.id);
  }
});

test("pull_request with DEPLOYKIT_PREVIEW_DOMAIN generates auto-verified custom domain", async () => {
  if (!(await gateDb("services/previewDeployments.db.unit.test.ts", dbAvailable))) return;
  const prevEnv = process.env.DEPLOYKIT_PREVIEW_DOMAIN;
  const prevEnabled = enablePreviews();
  process.env.DEPLOYKIT_PREVIEW_DOMAIN = "preview.example.com";
  const parent = await createProject(`pr-proj-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: parent.id,
      installationId: "777",
      repositoryFullName: "acme/preview-app-domain",
      autoDeploy: true,
    });

    await handleGitHubWebhook({
      deliveryId: `pr-del-${Date.now()}-dom`,
      event: "pull_request",
      rawBody: prBody({ action: "opened", fullName: "acme/preview-app-domain", prNumber: 99, headSha: SHA_PR_1 }),
    });

    const preview = await findPreviewProject(parent.id, 99);
    assert.ok(preview);

    const expectedDomain = generatePreviewDomain(parent.id, 99, "preview.example.com");
    const domainRow = (
      await pool.query(`SELECT domain, status FROM custom_domains WHERE project_id = $1`, [preview.id])
    ).rows[0];

    assert.ok(domainRow);
    assert.equal(domainRow.domain, expectedDomain);
    assert.equal(domainRow.status, "verified");
  } finally {
    restoreEnv("DEPLOYKIT_PREVIEW_DOMAIN", prevEnv);
    restoreEnv("DEPLOYKIT_PREVIEW_DEPLOYS", prevEnabled);
    await cleanup(parent.id);
  }
});

test("pull_request closed tears down shadow project", async () => {
  if (!(await gateDb("services/previewDeployments.db.unit.test.ts", dbAvailable))) return;
  const prevEnabled = enablePreviews();
  const parent = await createProject(`pr-proj-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: parent.id,
      installationId: "777",
      repositoryFullName: "acme/preview-app-close",
      autoDeploy: true,
    });

    // 1. Opened
    await handleGitHubWebhook({
      deliveryId: `pr-del-${Date.now()}-open-then-close`,
      event: "pull_request",
      rawBody: prBody({ action: "opened", fullName: "acme/preview-app-close", prNumber: 55, headSha: SHA_PR_1 }),
    });

    const previewBefore = await findPreviewProject(parent.id, 55);
    assert.ok(previewBefore);

    // 2. Closed
    const closeOutcome = await handleGitHubWebhook({
      deliveryId: `pr-del-${Date.now()}-close`,
      event: "pull_request",
      rawBody: prBody({ action: "closed", fullName: "acme/preview-app-close", prNumber: 55 }),
    });

    assert.equal(closeOutcome.status, "processed");

    const previewAfter = await findPreviewProject(parent.id, 55);
    assert.equal(previewAfter, null);
  } finally {
    restoreEnv("DEPLOYKIT_PREVIEW_DEPLOYS", prevEnabled);
    await cleanup(parent.id);
  }
});

test("the host kill switch fails closed on previews", async () => {
  if (!(await gateDb("services/previewDeployments.db.unit.test.ts", dbAvailable))) return;
  const previous = process.env.DEPLOYKIT_PREVIEW_DEPLOYS;
  const parent = await createProject(`pr-proj-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: parent.id,
      installationId: "777",
      repositoryFullName: "acme/preview-app-switch",
      autoDeploy: true,
    });

    const outcome = await handleGitHubWebhook({
      deliveryId: `pr-del-${Date.now()}-switch`,
      event: "pull_request",
      rawBody: prBody({ action: "opened", fullName: "acme/preview-app-switch", prNumber: 7 }),
    });

    assert.equal(outcome.status, "ignored");
    assert.equal(outcome.reason, "preview_deployments_disabled_env");
    const preview = await findPreviewProject(parent.id, 7);
    assert.equal(preview, null, "no shadow project may exist while previews are off");
  } finally {
    restoreEnv("DEPLOYKIT_PREVIEW_DEPLOYS", previous);
    await cleanup(parent.id);
  }
});

test("fork PR heads are never built", async () => {
  if (!(await gateDb("services/previewDeployments.db.unit.test.ts", dbAvailable))) return;
  const previous = enablePreviews();
  const parent = await createProject(`pr-proj-${Date.now()}`);
  try {
    await linkProjectRepository({
      projectId: parent.id,
      installationId: "777",
      repositoryFullName: "acme/preview-app-fork",
      autoDeploy: true,
    });

    const body = Buffer.from(
      JSON.stringify({
        action: "opened",
        number: 8,
        pull_request: {
          number: 8,
          head: { sha: SHA_PR_1, ref: "fork-branch", repo: { full_name: "other-user/preview-app-fork" } },
          base: { ref: "main" },
        },
        repository: { full_name: "acme/preview-app-fork", id: 101 },
        installation: { id: 777 },
      })
    );

    const outcome = await handleGitHubWebhook({
      deliveryId: `pr-del-${Date.now()}-fork`,
      event: "pull_request",
      rawBody: body,
    });

    assert.equal(outcome.status, "ignored");
    assert.equal(outcome.reason, "fork_pr_unsupported");
    const preview = await findPreviewProject(parent.id, 8);
    assert.equal(preview, null, "no shadow project may exist for a fork head");
  } finally {
    restoreEnv("DEPLOYKIT_PREVIEW_DEPLOYS", previous);
    await cleanup(parent.id);
  }
});

test("push events match the parent project even while previews exist", async () => {
  if (!(await gateDb("services/previewDeployments.db.unit.test.ts", dbAvailable))) return;
  const previous = enablePreviews();
  const parent = await createProject(`pr-proj-${Date.now()}`, "main");
  try {
    await linkProjectRepository({
      projectId: parent.id,
      installationId: "777",
      repositoryFullName: "acme/preview-app-push",
      autoDeploy: true,
    });

    await handleGitHubWebhook({
      deliveryId: `pr-del-${Date.now()}-push-pr`,
      event: "pull_request",
      rawBody: prBody({ action: "opened", fullName: "acme/preview-app-push", prNumber: 3, headRef: "main" }),
    });
    assert.ok(await findPreviewProject(parent.id, 3));

    // A push of the same branch must never land on the shadow project.
    const pushBody = Buffer.from(
      JSON.stringify({
        ref: "refs/heads/main",
        after: SHA_PR_2,
        repository: { full_name: "acme/preview-app-push", id: 101 },
        installation: { id: 777 },
      })
    );
    const pushOutcome = await handleGitHubWebhook({
      deliveryId: `pr-del-${Date.now()}-push`,
      event: "push",
      rawBody: pushBody,
    });

    assert.equal(pushOutcome.status, "processed");
    const row = (
      await pool.query(
        `SELECT d.project_id, p.parent_project_id, p.is_preview
         FROM deployments d JOIN projects p ON p.id = d.project_id
         WHERE d.id = $1`,
        [pushOutcome.deploymentId]
      )
    ).rows[0];
    assert.equal(row.project_id, parent.id, "push must deploy the parent project");
    assert.equal(row.is_preview, false);
    assert.equal(row.parent_project_id, null);
  } finally {
    restoreEnv("DEPLOYKIT_PREVIEW_DEPLOYS", previous);
    await cleanup(parent.id);
  }
});
