import test from "node:test";
import assert from "node:assert/strict";
import "../test/testEnv.js";
import pool from "../db/database.js";
import { gateDb } from "../test/dbGate.js";
import {
  checkDeploymentRateLimit,
  checkWebhookRateLimit,
  deploymentProjectBucket,
  deploymentUserBucket,
  resetRateLimitKey,
  webhookIpBucket,
  RateLimitError,
} from "./rateLimitService.js";
import { getProjectDeployments } from "./deploymentService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.auth_rate_limits') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

test("checkDeploymentRateLimit persists rate limit counters and enforces thresholds", async () => {
  if (!(await gateDb("services/deploymentRateLimit.db.unit.test.ts", dbAvailable))) return;

  const projectId = "99999999-9999-9999-9999-999999999991";
  const userId = "88888888-8888-8888-8888-888888888881";
  const projKey = deploymentProjectBucket(projectId);
  const userKey = deploymentUserBucket(userId);

  const prevProjMax = process.env.DEPLOYKIT_DEPLOYMENT_RATE_LIMIT_PROJECT_MAX;
  process.env.DEPLOYKIT_DEPLOYMENT_RATE_LIMIT_PROJECT_MAX = "2";

  try {
    await resetRateLimitKey(projKey);
    await resetRateLimitKey(userKey);

    // Call 1: Allowed
    await checkDeploymentRateLimit({ projectId, userId, ip: "127.0.0.1" });

    // Call 2: Allowed
    await checkDeploymentRateLimit({ projectId, userId, ip: "127.0.0.1" });

    // Verify DB row
    const row = await pool.query(`SELECT count FROM auth_rate_limits WHERE key = $1`, [projKey]);
    assert.equal(row.rows[0].count, 2);

    // Call 3: Exceeds threshold of 2
    await assert.rejects(
      async () => {
        await checkDeploymentRateLimit({ projectId, userId, ip: "127.0.0.1" });
      },
      (err: any) => {
        assert.ok(err instanceof RateLimitError);
        assert.equal(err.code, "RATE_LIMITED");
        assert.ok(err.retryAfterSeconds > 0);
        return true;
      }
    );
  } finally {
    if (prevProjMax !== undefined) process.env.DEPLOYKIT_DEPLOYMENT_RATE_LIMIT_PROJECT_MAX = prevProjMax;
    else delete process.env.DEPLOYKIT_DEPLOYMENT_RATE_LIMIT_PROJECT_MAX;
    await resetRateLimitKey(projKey);
    await resetRateLimitKey(userKey);
  }
});

test("checkWebhookRateLimit persists IP rate limit counters and rejects bursts", async () => {
  if (!(await gateDb("services/deploymentRateLimit.db.unit.test.ts", dbAvailable))) return;

  const ip = "198.51.100.42";
  const ipKey = webhookIpBucket(ip);

  const prevWebhookMax = process.env.DEPLOYKIT_WEBHOOK_RATE_LIMIT_IP_MAX;
  process.env.DEPLOYKIT_WEBHOOK_RATE_LIMIT_IP_MAX = "2";

  try {
    await resetRateLimitKey(ipKey);

    // Call 1
    await checkWebhookRateLimit({ ip });
    // Call 2
    await checkWebhookRateLimit({ ip });

    const row = await pool.query(`SELECT count FROM auth_rate_limits WHERE key = $1`, [ipKey]);
    assert.equal(row.rows[0].count, 2);

    // Call 3: Exceeds threshold
    await assert.rejects(
      async () => {
        await checkWebhookRateLimit({ ip });
      },
      (err: any) => {
        assert.ok(err instanceof RateLimitError);
        assert.equal(err.code, "RATE_LIMITED");
        return true;
      }
    );
  } finally {
    if (prevWebhookMax !== undefined) process.env.DEPLOYKIT_WEBHOOK_RATE_LIMIT_IP_MAX = prevWebhookMax;
    else delete process.env.DEPLOYKIT_WEBHOOK_RATE_LIMIT_IP_MAX;
    await resetRateLimitKey(ipKey);
  }
});

test("getProjectDeployments executes cursor-based pagination against real database", async () => {
  if (!(await gateDb("services/deploymentRateLimit.db.unit.test.ts", dbAvailable))) return;

  const projectId = "77777777-7777-7777-7777-777777777777";

  try {
    // Insert test project with correct column repository_url
    await pool.query(
      `INSERT INTO projects (id, name, repository_url, branch)
       VALUES ($1, 'rate-limit-test-proj', 'https://github.com/test/repo', 'main')
       ON CONFLICT (id) DO NOTHING`,
      [projectId]
    );

    // Clean any leftover deployments
    await pool.query(`DELETE FROM deployments WHERE project_id = $1`, [projectId]);

    // Insert 3 deployments with distinct created_at
    const d1 = await pool.query(
      `INSERT INTO deployments (project_id, trigger, status, branch, created_at)
       VALUES ($1, 'manual', 'active', 'main', NOW() - INTERVAL '3 minutes') RETURNING id`,
      [projectId]
    );
    const d2 = await pool.query(
      `INSERT INTO deployments (project_id, trigger, status, branch, created_at)
       VALUES ($1, 'manual', 'active', 'main', NOW() - INTERVAL '2 minutes') RETURNING id`,
      [projectId]
    );
    const d3 = await pool.query(
      `INSERT INTO deployments (project_id, trigger, status, branch, created_at)
       VALUES ($1, 'manual', 'active', 'main', NOW() - INTERVAL '1 minute') RETURNING id`,
      [projectId]
    );

    const id3 = d3.rows[0].id; // newest
    const id2 = d2.rows[0].id; // middle
    const id1 = d1.rows[0].id; // oldest

    // Page 1: limit 2
    const page1 = await getProjectDeployments(projectId, { limit: 2 });
    assert.equal(page1.length, 2);
    assert.equal(page1[0].id, id3);
    assert.equal(page1[1].id, id2);

    // Page 2: cursor id2
    const page2 = await getProjectDeployments(projectId, { limit: 2, cursor: id2 });
    assert.equal(page2.length, 1);
    assert.equal(page2[0].id, id1);

    // Page 3: cursor id1 (no more items)
    const page3 = await getProjectDeployments(projectId, { limit: 2, cursor: id1 });
    assert.equal(page3.length, 0);
  } finally {
    await pool.query(`DELETE FROM deployments WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  }
});

test("getDeploymentEvents executes forward cursor pagination against real database", async () => {
  if (!(await gateDb("services/deploymentRateLimit.db.unit.test.ts", dbAvailable))) return;

  const projectId = "77777777-7777-7777-7777-777777777778";
  const depId = "66666666-6666-6666-6666-666666666666";

  try {
    await pool.query(
      `INSERT INTO projects (id, name, repository_url, branch)
       VALUES ($1, 'rate-limit-event-proj', 'https://github.com/test/repo', 'main')
       ON CONFLICT (id) DO NOTHING`,
      [projectId]
    );

    await pool.query(
      `INSERT INTO deployments (id, project_id, trigger, status, branch)
       VALUES ($1, $2, 'manual', 'active', 'main')
       ON CONFLICT (id) DO NOTHING`,
      [depId, projectId]
    );

    await pool.query(`DELETE FROM deployment_events WHERE deployment_id = $1`, [depId]);

    const e1 = await pool.query(
      `INSERT INTO deployment_events (deployment_id, event_type, status_from, status_to, message, created_at)
       VALUES ($1, 'status_change', 'queued', 'building', 'step 1', NOW() - INTERVAL '3 minutes') RETURNING id`,
      [depId]
    );
    const e2 = await pool.query(
      `INSERT INTO deployment_events (deployment_id, event_type, status_from, status_to, message, created_at)
       VALUES ($1, 'status_change', 'building', 'deploying', 'step 2', NOW() - INTERVAL '2 minutes') RETURNING id`,
      [depId]
    );
    const e3 = await pool.query(
      `INSERT INTO deployment_events (deployment_id, event_type, status_from, status_to, message, created_at)
       VALUES ($1, 'status_change', 'deploying', 'active', 'step 3', NOW() - INTERVAL '1 minute') RETURNING id`,
      [depId]
    );

    const id1 = e1.rows[0].id;
    const id2 = e2.rows[0].id;
    const id3 = e3.rows[0].id;

    const { getDeploymentEvents } = await import("./deploymentService.js");

    // Page 1: limit 2
    const page1 = await getDeploymentEvents(depId, { limit: 2 });
    assert.equal(page1.length, 2);
    assert.equal(page1[0].id, id1);
    assert.equal(page1[1].id, id2);

    // Page 2: forward cursor id2
    const page2 = await getDeploymentEvents(depId, { limit: 2, cursor: id2 });
    assert.equal(page2.length, 1);
    assert.equal(page2[0].id, id3);

    // Page 3: forward cursor id3
    const page3 = await getDeploymentEvents(depId, { limit: 2, cursor: id3 });
    assert.equal(page3.length, 0);
  } finally {
    await pool.query(`DELETE FROM deployment_events WHERE deployment_id = $1`, [depId]);
    await pool.query(`DELETE FROM deployments WHERE id = $1`, [depId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  }
});

test("getProjectReleases executes cursor pagination against real database", async () => {
  if (!(await gateDb("services/deploymentRateLimit.db.unit.test.ts", dbAvailable))) return;

  const projectId = "77777777-7777-7777-7777-777777777779";
  const dep1 = "55555555-5555-5555-5555-555555555551";
  const dep2 = "55555555-5555-5555-5555-555555555552";
  const dep3 = "55555555-5555-5555-5555-555555555553";

  try {
    await pool.query(
      `INSERT INTO projects (id, name, repository_url, branch)
       VALUES ($1, 'rate-limit-rel-proj', 'https://github.com/test/repo', 'main')
       ON CONFLICT (id) DO NOTHING`,
      [projectId]
    );

    for (const d of [dep1, dep2, dep3]) {
      await pool.query(
        `INSERT INTO deployments (id, project_id, trigger, status, branch)
         VALUES ($1, $2, 'manual', 'active', 'main')
         ON CONFLICT (id) DO NOTHING`,
        [d, projectId]
      );
    }

    await pool.query(`DELETE FROM releases WHERE project_id = $1`, [projectId]);

    const r1 = await pool.query(
      `INSERT INTO releases (deployment_id, project_id, image_repository, image_digest, commit_sha, branch, status, created_at)
       VALUES ($1, $2, 'test/img', 'sha256:1111111111111111111111111111111111111111111111111111111111111111', '1111111111111111111111111111111111111111', 'main', 'stopped', NOW() - INTERVAL '3 minutes') RETURNING id`,
      [dep1, projectId]
    );
    const r2 = await pool.query(
      `INSERT INTO releases (deployment_id, project_id, image_repository, image_digest, commit_sha, branch, status, created_at)
       VALUES ($1, $2, 'test/img', 'sha256:2222222222222222222222222222222222222222222222222222222222222222', '2222222222222222222222222222222222222222', 'main', 'stopped', NOW() - INTERVAL '2 minutes') RETURNING id`,
      [dep2, projectId]
    );
    const r3 = await pool.query(
      `INSERT INTO releases (deployment_id, project_id, image_repository, image_digest, commit_sha, branch, status, created_at)
       VALUES ($1, $2, 'test/img', 'sha256:3333333333333333333333333333333333333333333333333333333333333333', '3333333333333333333333333333333333333333', 'main', 'active', NOW() - INTERVAL '1 minute') RETURNING id`,
      [dep3, projectId]
    );

    const id1 = r1.rows[0].id; // oldest
    const id2 = r2.rows[0].id; // middle
    const id3 = r3.rows[0].id; // newest

    const { getProjectReleases } = await import("./releaseService.js");

    // Page 1: limit 2
    const page1 = await getProjectReleases(projectId, { limit: 2 });
    assert.equal(page1.length, 2);
    assert.equal(page1[0].id, id3);
    assert.equal(page1[1].id, id2);

    // Page 2: cursor id2
    const page2 = await getProjectReleases(projectId, { limit: 2, cursor: id2 });
    assert.equal(page2.length, 1);
    assert.equal(page2[0].id, id1);

    // Page 3: cursor id1
    const page3 = await getProjectReleases(projectId, { limit: 2, cursor: id1 });
    assert.equal(page3.length, 0);
  } finally {
    await pool.query(`DELETE FROM releases WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM deployments WHERE id IN ($1, $2, $3)`, [dep1, dep2, dep3]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  }
});
