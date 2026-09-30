import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import {
  activateRelease,
  createRelease,
  getActiveRelease,
  markRelease,
} from "./releaseService.js";
import { getProjectGateway } from "./gatewayService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    const check = await pool.query(
      `SELECT to_regclass('public.project_gateways') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;

async function createProject(name: string) {
  return (
    await pool.query(
      `INSERT INTO projects (name, repository_url, branch)
       VALUES ($1, 'https://github.com/acme/app.git', 'main') RETURNING *`,
      [name]
    )
  ).rows[0];
}

async function createDeployment(projectId: string, status = "deploying") {
  return (
    await pool.query(
      `INSERT INTO deployments (project_id, status, trigger, branch)
       VALUES ($1, $2, 'manual', 'main') RETURNING *`,
      [projectId, status]
    )
  ).rows[0];
}

function route(container: string) {
  return {
    gatewayName: "dk-gateway",
    containerName: container,
    containerIp: "172.20.0.9",
    containerPort: 3000,
  };
}

async function releaseFor(deploymentId: string, projectId: string, healthy: boolean) {
  const rel = await createRelease({
    deploymentId,
    projectId,
    imageRepository: "deploykit/app",
    imageDigest: DIGEST,
    commitSha: SHA_A,
    branch: "main",
    supersedesReleaseId: null,
  });
  if (healthy) {
    await markRelease(rel.id, "starting");
    await markRelease(rel.id, "healthy");
  }
  return (await pool.query(`SELECT * FROM releases WHERE id = $1`, [rel.id])).rows[0];
}

test("non-healthy release never replaces the active release", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`gw-pending-${Date.now()}`);
  try {
    const dep1 = await createDeployment(project.id);
    const rel1 = await releaseFor(dep1.id, project.id, true);
    await activateRelease(project.id, rel1.id, dep1.id, route("dk-old"));
    const dep2 = await createDeployment(project.id);
    const rel2 = await releaseFor(dep2.id, project.id, false);
    await assert.rejects(
      activateRelease(project.id, rel2.id, dep2.id, route("dk-new"))
    );
    assert.equal((await getActiveRelease(project.id)).id, rel1.id);
    const gateway = await getProjectGateway(project.id);
    assert.equal(gateway.target_container, "dk-old");
    assert.equal(gateway.active_release_id, rel1.id);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("healthy release switches traffic and retires the old release", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`gw-switch-${Date.now()}`);
  try {
    const dep1 = await createDeployment(project.id);
    const rel1 = await releaseFor(dep1.id, project.id, true);
    await activateRelease(project.id, rel1.id, dep1.id, route("dk-old"));
    const dep2 = await createDeployment(project.id);
    const rel2 = await releaseFor(dep2.id, project.id, true);
    await activateRelease(project.id, rel2.id, dep2.id, route("dk-new"));
    assert.equal((await getActiveRelease(project.id)).id, rel2.id);
    const old = await pool.query(`SELECT status FROM releases WHERE id = $1`, [
      rel1.id,
    ]);
    assert.equal(old.rows[0].status, "stopped");
    const gateway = await getProjectGateway(project.id);
    assert.equal(gateway.active_release_id, rel2.id);
    assert.equal(gateway.target_container, "dk-new");
    assert.equal(gateway.target_ip, "172.20.0.9");
    const dep = await pool.query(
      `SELECT release_id FROM deployments WHERE id = $1`,
      [dep2.id]
    );
    assert.equal(dep.rows[0].release_id, rel2.id);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("repeated activation of the same release is idempotent", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`gw-idem-${Date.now()}`);
  try {
    const dep = await createDeployment(project.id);
    const rel = await releaseFor(dep.id, project.id, true);
    await activateRelease(project.id, rel.id, dep.id, route("dk-one"));
    await activateRelease(project.id, rel.id, dep.id, route("dk-one"));
    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM releases WHERE project_id = $1 AND status = 'active'`,
      [project.id]
    );
    assert.equal(count.rows[0].n, 1);
    assert.equal((await getActiveRelease(project.id)).id, rel.id);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("concurrent activations serialize to one active release", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`gw-conc-${Date.now()}`);
  try {
    const dep1 = await createDeployment(project.id);
    const dep2 = await createDeployment(project.id);
    const rel1 = await releaseFor(dep1.id, project.id, true);
    const rel2 = await createRelease({
      deploymentId: dep2.id,
      projectId: project.id,
      imageRepository: "deploykit/app",
      imageDigest: DIGEST,
      commitSha: SHA_B,
      branch: "main",
      supersedesReleaseId: null,
    }).then(async (r) => {
      await markRelease(r.id, "starting");
      await markRelease(r.id, "healthy");
      return (await pool.query(`SELECT * FROM releases WHERE id = $1`, [r.id])).rows[0];
    });
    await Promise.all([
      activateRelease(project.id, rel1.id, dep1.id, route("dk-a")),
      activateRelease(project.id, rel2.id, dep2.id, route("dk-b")),
    ]);
    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM releases WHERE project_id = $1 AND status = 'active'`,
      [project.id]
    );
    assert.equal(count.rows[0].n, 1);
    const gateway = await getProjectGateway(project.id);
    assert.equal(gateway.active_release_id, (await getActiveRelease(project.id)).id);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("cross-project activation is rejected", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const projectA = await createProject(`gw-x-a-${Date.now()}`);
  const projectB = await createProject(`gw-x-b-${Date.now()}`);
  try {
    const depB = await createDeployment(projectB.id);
    const relB = await releaseFor(depB.id, projectB.id, true);
    const depA = await createDeployment(projectA.id);
    await assert.rejects(
      activateRelease(projectA.id, relB.id, depA.id, route("dk-x"))
    );
    assert.equal(await getActiveRelease(projectA.id), null);
    assert.equal(await getProjectGateway(projectA.id), null);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id IN ($1, $2)`, [
      projectA.id,
      projectB.id,
    ]);
  }
});

test("terminal releases cannot transition", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`gw-term-${Date.now()}`);
  try {
    const dep = await createDeployment(project.id);
    const rel = await releaseFor(dep.id, project.id, true);
    await activateRelease(project.id, rel.id, dep.id, route("dk-t"));
    await assert.rejects(markRelease(rel.id, "failed"));
    await assert.rejects(markRelease(rel.id, "healthy"));
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});
