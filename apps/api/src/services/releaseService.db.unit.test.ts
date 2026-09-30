import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import {
  activateRelease,
  createRelease,
  getActiveRelease,
} from "./releaseService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

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

async function countActive(projectId: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM releases WHERE project_id = $1 AND status = 'active'`,
    [projectId]
  );
  return result.rows[0].n;
}

test("sequential activations leave exactly one active release", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`rel-seq-${Date.now()}`);
  try {
    const dep1 = await createDeployment(project.id);
    const rel1 = await createRelease({
      deploymentId: dep1.id,
      projectId: project.id,
      imageRepository: "deploykit/app",
      imageDigest: DIGEST_A,
      commitSha: SHA_A,
      branch: "main",
      supersedesReleaseId: null,
    });
    await pool.query(`UPDATE releases SET status = 'healthy' WHERE id = $1`, [
      rel1.id,
    ]);
    await activateRelease(project.id, rel1.id, dep1.id);

    const dep2 = await createDeployment(project.id);
    const rel2 = await createRelease({
      deploymentId: dep2.id,
      projectId: project.id,
      imageRepository: "deploykit/app",
      imageDigest: DIGEST_B,
      commitSha: SHA_B,
      branch: "main",
      supersedesReleaseId: rel1.id,
    });
    await pool.query(`UPDATE releases SET status = 'healthy' WHERE id = $1`, [
      rel2.id,
    ]);
    await activateRelease(project.id, rel2.id, dep2.id);

    assert.equal(await countActive(project.id), 1);
    assert.equal((await getActiveRelease(project.id)).id, rel2.id);
    const old = await pool.query(`SELECT status FROM releases WHERE id = $1`, [
      rel1.id,
    ]);
    assert.equal(old.rows[0].status, "stopped");
    const depRow = await pool.query(
      `SELECT release_id FROM deployments WHERE id = $1`,
      [dep2.id]
    );
    assert.equal(depRow.rows[0].release_id, rel2.id);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("failed activation leaves the old active release intact", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`rel-fail-${Date.now()}`);
  try {
    const dep1 = await createDeployment(project.id);
    const rel1 = await createRelease({
      deploymentId: dep1.id,
      projectId: project.id,
      imageRepository: "deploykit/app",
      imageDigest: DIGEST_A,
      commitSha: SHA_A,
      branch: "main",
      supersedesReleaseId: null,
    });
    await pool.query(`UPDATE releases SET status = 'healthy' WHERE id = $1`, [
      rel1.id,
    ]);
    await activateRelease(project.id, rel1.id, dep1.id);

    const dep2 = await createDeployment(project.id);
    const rel2 = await createRelease({
      deploymentId: dep2.id,
      projectId: project.id,
      imageRepository: "deploykit/app",
      imageDigest: DIGEST_B,
      commitSha: SHA_B,
      branch: "main",
      supersedesReleaseId: rel1.id,
    });
    await assert.rejects(
      activateRelease(project.id, rel2.id, dep2.id),
      /healthy/
    );

    assert.equal(await countActive(project.id), 1);
    assert.equal((await getActiveRelease(project.id)).id, rel1.id);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("activation rejects releases from another project", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const projectA = await createProject(`rel-own-a-${Date.now()}`);
  const projectB = await createProject(`rel-own-b-${Date.now()}`);
  try {
    const depB = await createDeployment(projectB.id);
    const relB = await createRelease({
      deploymentId: depB.id,
      projectId: projectB.id,
      imageRepository: "deploykit/app",
      imageDigest: DIGEST_A,
      commitSha: SHA_A,
      branch: "main",
      supersedesReleaseId: null,
    });
    await pool.query(`UPDATE releases SET status = 'healthy' WHERE id = $1`, [
      relB.id,
    ]);
    const depA = await createDeployment(projectA.id);
    await assert.rejects(
      activateRelease(projectA.id, relB.id, depA.id),
      /belong/
    );
    assert.equal(await countActive(projectA.id), 0);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id IN ($1, $2)`, [
      projectA.id,
      projectB.id,
    ]);
  }
});

test("activation scopes the deployment update to the project", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const projectA = await createProject(`rel-scope-a-${Date.now()}`);
  const projectB = await createProject(`rel-scope-b-${Date.now()}`);
  try {
    const depA = await createDeployment(projectA.id);
    const relA = await createRelease({
      deploymentId: depA.id,
      projectId: projectA.id,
      imageRepository: "deploykit/app",
      imageDigest: DIGEST_A,
      commitSha: SHA_A,
      branch: "main",
      supersedesReleaseId: null,
    });
    await pool.query(`UPDATE releases SET status = 'healthy' WHERE id = $1`, [
      relA.id,
    ]);
    const depB = await createDeployment(projectB.id);
    await assert.rejects(
      activateRelease(projectA.id, relA.id, depB.id),
      /Deployment not found/
    );
    assert.equal(await countActive(projectA.id), 0);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id IN ($1, $2)`, [
      projectA.id,
      projectB.id,
    ]);
  }
});

test("concurrent activations serialize to exactly one active release", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`rel-conc-${Date.now()}`);
  try {
    const dep1 = await createDeployment(project.id);
    const dep2 = await createDeployment(project.id);
    const rel1 = await createRelease({
      deploymentId: dep1.id,
      projectId: project.id,
      imageRepository: "deploykit/app",
      imageDigest: DIGEST_A,
      commitSha: SHA_A,
      branch: "main",
      supersedesReleaseId: null,
    });
    const rel2 = await createRelease({
      deploymentId: dep2.id,
      projectId: project.id,
      imageRepository: "deploykit/app",
      imageDigest: DIGEST_B,
      commitSha: SHA_B,
      branch: "main",
      supersedesReleaseId: null,
    });
    await pool.query(
      `UPDATE releases SET status = 'healthy' WHERE id IN ($1, $2)`,
      [rel1.id, rel2.id]
    );
    await Promise.all([
      activateRelease(project.id, rel1.id, dep1.id),
      activateRelease(project.id, rel2.id, dep2.id),
    ]);
    assert.equal(await countActive(project.id), 1);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("duplicate release for one deployment is rejected", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`rel-dup-${Date.now()}`);
  try {
    const dep = await createDeployment(project.id);
    await createRelease({
      deploymentId: dep.id,
      projectId: project.id,
      imageRepository: "deploykit/app",
      imageDigest: DIGEST_A,
      commitSha: SHA_A,
      branch: "main",
      supersedesReleaseId: null,
    });
    await assert.rejects(
      createRelease({
        deploymentId: dep.id,
        projectId: project.id,
        imageRepository: "deploykit/app",
        imageDigest: DIGEST_B,
        commitSha: SHA_B,
        branch: "main",
        supersedesReleaseId: null,
      }),
      /already exists/
    );
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("release creation validates digest, sha and ownership", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`rel-val-${Date.now()}`);
  const other = await createProject(`rel-val-other-${Date.now()}`);
  try {
    const dep = await createDeployment(project.id);
    await assert.rejects(
      createRelease({
        deploymentId: dep.id,
        projectId: project.id,
        imageRepository: "deploykit/app",
        imageDigest: "deploykit/app:latest",
        commitSha: SHA_A,
        branch: "main",
        supersedesReleaseId: null,
      }),
      /digest/
    );
    await assert.rejects(
      createRelease({
        deploymentId: dep.id,
        projectId: project.id,
        imageRepository: "deploykit/app",
        imageDigest: DIGEST_A,
        commitSha: "short",
        branch: "main",
        supersedesReleaseId: null,
      }),
      /commit SHA/
    );
    await assert.rejects(
      createRelease({
        deploymentId: dep.id,
        projectId: other.id,
        imageRepository: "deploykit/app",
        imageDigest: DIGEST_A,
        commitSha: SHA_A,
        branch: "main",
        supersedesReleaseId: null,
      }),
      /belong/
    );
  } finally {
    await pool.query(`DELETE FROM projects WHERE id IN ($1, $2)`, [
      project.id,
      other.id,
    ]);
  }
});
