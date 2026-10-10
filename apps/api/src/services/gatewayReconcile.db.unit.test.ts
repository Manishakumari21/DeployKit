import test from "node:test";
import assert from "node:assert/strict";
import pool from "../db/database.js";
import {
  reconcileActiveGateways,
  reconcileProjectGateway,
} from "./gatewayService.js";
import type { RouteTarget } from "../infrastructure/gateway/trafficRouter.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    const check = await pool.query(
      `SELECT to_regclass('public.runtime_instances') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

interface FakeRouter {
  synced: RouteTarget[];
  verified: number;
  failSync: boolean;
  onSync?: (target: RouteTarget) => Promise<void>;
  router: {
    sync: (target: RouteTarget) => Promise<void>;
    verifyRoute: () => Promise<void>;
    remove: () => Promise<void>;
    activeTarget: () => Promise<null>;
  };
}

function fakeRouter(): FakeRouter {
  const fake: FakeRouter = {
    synced: [],
    verified: 0,
    failSync: false,
    router: {
      sync: async (target: RouteTarget) => {
        if (fake.failSync) throw new Error("gateway unreachable");
        await fake.onSync?.(target);
        fake.synced.push(target);
      },
      verifyRoute: async () => {
        fake.verified += 1;
      },
      remove: async () => undefined,
      activeTarget: async () => null,
    },
  };
  return fake;
}

async function createProject(name: string) {
  const result = await pool.query(
    `INSERT INTO projects (name, repository_url, branch) VALUES ($1, 'https://github.com/acme/app.git', 'main') RETURNING *`,
    [name]
  );
  return result.rows[0];
}

async function createDeployment(projectId: string) {
  const result = await pool.query(
    `INSERT INTO deployments (project_id, status, trigger, branch) VALUES ($1, 'deploying', 'manual', 'main') RETURNING *`,
    [projectId]
  );
  return result.rows[0];
}

async function createRelease(
  deploymentId: string,
  projectId: string,
  digest: string,
  status: string
) {
  const result = await pool.query(
    `INSERT INTO releases (deployment_id, project_id, image_repository, image_digest, commit_sha, branch, status)
     VALUES ($1, $2, 'deploykit/app', $3, $4, 'main', $5) RETURNING *`,
    [deploymentId, projectId, digest, SHA, status]
  );
  return result.rows[0];
}

async function createRuntime(releaseId: string, name: string) {
  await pool.query(
    `INSERT INTO runtime_instances (release_id, status, container_name, container_port, host_port, ip_address)
     VALUES ($1, 'running', $2, 3000, 31001, '172.19.0.50')`,
    [releaseId, name]
  );
}

async function setupActiveProject(tag: string, digest = DIGEST_A) {
  const project = await createProject(`gw-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const deployment = await createDeployment(project.id);
  const release = await createRelease(deployment.id, project.id, digest, "active");
  await createRuntime(release.id, `gw-${tag}-ctr`);
  return { project, deployment, release };
}

test("reconciliation converges a stale gateway to the database active release", async () => {
  if (!(await dbAvailable())) return;
  const { project, release } = await setupActiveProject("converge");
  const fake = fakeRouter();
  try {
    const first = await reconcileProjectGateway(project.id, { router: fake.router as never });
    assert.equal(first.status, "reconciled");
    assert.equal(first.releaseId, release.id);
    assert.equal(fake.synced.length, 1);
    assert.equal(fake.synced[0].releaseId, release.id);
    const second = await reconcileProjectGateway(project.id, { router: fake.router as never });
    assert.equal(second.status, "reconciled");
    assert.equal(second.releaseId, release.id);
    assert.equal(fake.synced.length, 2);
    assert.deepEqual(fake.synced[1], fake.synced[0]);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("stale reconciliation cannot overwrite a newer active release", async () => {
  if (!(await dbAvailable())) return;
  const { project, release: releaseA } = await setupActiveProject("stale", DIGEST_A);
  const depB = await createDeployment(project.id);
  const releaseB = await createRelease(depB.id, project.id, DIGEST_B, "healthy");
  await createRuntime(releaseB.id, `gw-stale-ctr-b`);
  const fake = fakeRouter();
  let flipped = false;
  fake.onSync = async () => {
    if (!flipped) {
      flipped = true;
      await pool.query(`UPDATE releases SET status = 'stopped' WHERE id = $1`, [releaseA.id]);
      await pool.query(`UPDATE releases SET status = 'active' WHERE id = $1`, [releaseB.id]);
    }
  };
  try {
    const result = await reconcileProjectGateway(project.id, { router: fake.router as never });
    assert.equal(result.status, "reconciled");
    assert.equal(result.releaseId, releaseB.id);
    assert.equal(fake.synced[fake.synced.length - 1].releaseId, releaseB.id);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("no active release is a no-op that never touches the gateway", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`gw-none-${Date.now()}`);
  const fake = fakeRouter();
  try {
    const result = await reconcileProjectGateway(project.id, { router: fake.router as never });
    assert.equal(result.status, "no-active-route");
    assert.equal(result.releaseId, null);
    assert.equal(fake.synced.length, 0);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("unavailable gateway surfaces the error for the caller to retry", async () => {
  if (!(await dbAvailable())) return;
  const { project } = await setupActiveProject("down");
  const fake = fakeRouter();
  fake.failSync = true;
  try {
    await assert.rejects(
      reconcileProjectGateway(project.id, { router: fake.router as never }),
      /gateway unreachable/
    );
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("startup-style sweep reconciles, skips, and counts failures without throwing", async () => {
  if (!(await dbAvailable())) return;
  const ok = await setupActiveProject("sweep-ok");
  const stuck = await setupActiveProject("sweep-stuck");
  await pool.query(`UPDATE runtime_instances SET status = 'stopped' WHERE release_id = $1`, [
    stuck.release.id,
  ]);
  const down = await setupActiveProject("sweep-down");
  const routers = new Map<string, FakeRouter>();
  const errors: string[] = [];
  const summary = await reconcileActiveGateways({
    createRouter: (projectId: string) => {
      const fake = fakeRouter();
      if (projectId === down.project.id) fake.failSync = true;
      routers.set(projectId, fake);
      return fake.router as never;
    },
    onProjectError: (projectId: string) => {
      errors.push(projectId);
    },
  });
  try {
    assert.equal(routers.get(ok.project.id)?.synced.length, 1);
    assert.equal(routers.get(ok.project.id)?.synced[0].releaseId, ok.release.id);
    assert.equal(routers.get(stuck.project.id)?.synced.length, 0);
    assert.deepEqual(errors, [down.project.id]);
    assert.ok(summary.reconciled >= 1);
    assert.ok(summary.skipped >= 1);
    assert.ok(summary.failed >= 1);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [ok.project.id]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [stuck.project.id]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [down.project.id]);
  }
});
