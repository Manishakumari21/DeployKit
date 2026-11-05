import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import { createAgent, createEnrollmentCredential } from "./agentService.js";
import { authenticateAgentToken } from "./agentAuthentication.js";
import { claimAgentJob, completeAgentJob } from "./agentJobService.js";
import { createDeployment, cancelDeployment } from "../services/deploymentService.js";
import { createRelease } from "../services/releaseService.js";
import { resolveActiveRoute } from "../services/gatewayService.js";
import { gateDb } from "../test/dbGate.js";

const IMAGE_REPO = "localhost:5000/deploykit/edge-activation";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.releases') AS r, to_regclass('public.runtime_instances') AS i`
    );
    return check.rows[0].r !== null && check.rows[0].i !== null;
  } catch {
    return false;
  }
}

function uniqueName(tag: string): string {
  const rand = Math.floor(Math.random() * 1_000_000);
  return `edge-act-${tag}-${Date.now()}-${rand}`;
}

async function makeProject(name: string): Promise<{ id: string }> {
  return (
    await pool.query(
      `INSERT INTO projects (name, repository_url, branch)
       VALUES ($1, 'https://github.com/acme/app.git', 'main')
       RETURNING id`,
      [name]
    )
  ).rows[0] as { id: string };
}

async function makeAgent(projectId: string, tag: string) {
  const agent = await createAgent(projectId, `edge-${tag}`);
  const cred = await createEnrollmentCredential(agent.id);
  assert.ok(await authenticateAgentToken(`Bearer ${cred.token}`));
  return agent;
}

async function setDeploymentImage(deploymentId: string, digest: string): Promise<void> {
  await pool.query(
    `UPDATE deployments SET image_repository = $2, image_digest = $3 WHERE id = $1`,
    [deploymentId, IMAGE_REPO, digest]
  );
}

async function runEdgeJob(
  agentId: string,
  projectId: string,
  digest: string
): Promise<string> {
  const deployment = await createDeployment({
    projectId,
    trigger: "manual",
    idempotencyKey: null,
    targetAgentId: agentId,
  });
  assert.ok(deployment);
  const depId = (deployment as { id: string }).id;
  await setDeploymentImage(depId, digest);
  const claimed = await claimAgentJob(agentId);
  assert.ok(claimed);
  const done = await completeAgentJob(agentId, (claimed as { id: string }).id, {
    outcome: "succeeded",
    imageDigest: digest,
    commitSha: "a".repeat(40),
    containerPort: 3000,
    hostPort: 32791,
  });
  assert.equal(done.result, "completed");
  return depId;
}

async function cleanupProject(projectId: string): Promise<void> {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
}

test("edge completion creates, healthy-marks, activates a release and records the edge runtime", async () => {
  if (!(await gateDb("agents/edgeActivation.db.unit.test.ts", dbAvailable))) return;
  const project = await makeProject(uniqueName("lifecycle"));
  try {
    const agent = await makeAgent(project.id, "runner");
    const deploymentId = await runEdgeJob(agent.id, project.id, `sha256:${"a".repeat(64)}`);

    const dep = (
      await pool.query(`SELECT status, release_id FROM deployments WHERE id = $1`, [deploymentId])
    ).rows[0] as { status: string; release_id: string };
    assert.equal(dep.status, "active");
    assert.ok(dep.release_id);

    const release = (
      await pool.query(`SELECT status, image_repository, image_digest, commit_sha FROM releases WHERE id = $1`, [
        dep.release_id,
      ])
    ).rows[0] as { status: string; image_repository: string; image_digest: string; commit_sha: string };
    assert.equal(release.status, "active");
    assert.equal(release.image_digest, `sha256:${"a".repeat(64)}`);
    assert.equal(release.commit_sha, "a".repeat(40));

    const runtime = (
      await pool.query(
        `SELECT container_name, ip_address, status, container_port, host_port
         FROM runtime_instances WHERE release_id = $1`,
        [dep.release_id]
      )
    ).rows[0] as {
      container_name: string;
      ip_address: string | null;
      status: string;
      container_port: number;
      host_port: number;
    };
    assert.match(runtime.container_name, /^dk-p[0-9a-f]{8}-d[0-9a-f]{8}$/);
    assert.match(runtime.container_name, new RegExp(`^dk-p${project.id.replace(/-/g, "").slice(0, 8)}`));
    assert.equal(runtime.ip_address, null);
    assert.equal(runtime.status, "running");
    assert.equal(runtime.container_port, 3000);
    assert.equal(runtime.host_port, 32791);

    const event = (
      await pool.query(
        `SELECT status_from, status_to, metadata FROM deployment_events
         WHERE deployment_id = $1 AND event_type = 'deployment.activated'
         ORDER BY id DESC LIMIT 1`,
        [deploymentId]
      )
    ).rows[0];
    assert.ok(event);
    assert.equal(event.status_to, "active");
    assert.equal((event.metadata as { source?: string }).source, "edge_agent");

    // Edge runtimes are invisible to central route resolution.
    assert.equal(await resolveActiveRoute(project.id), null);
  } finally {
    await cleanupProject(project.id);
  }
});

test("completion retries do not duplicate releases", async () => {
  if (!(await gateDb("agents/edgeActivation.db.unit.test.ts", dbAvailable))) return;
  const project = await makeProject(uniqueName("idempotent"));
  try {
    const agent = await makeAgent(project.id, "repeater");
    const deploymentId = await runEdgeJob(agent.id, project.id, `sha256:${"b".repeat(64)}`);
    const count = (
      await pool.query(`SELECT COUNT(*)::int AS n FROM releases WHERE deployment_id = $1`, [deploymentId])
    ).rows[0].n as number;
    assert.equal(count, 1);
  } finally {
    await cleanupProject(project.id);
  }
});

test("a second deploy stops the previous release and keeps one active per project", async () => {
  if (!(await gateDb("agents/edgeActivation.db.unit.test.ts", dbAvailable))) return;
  const project = await makeProject(uniqueName("switch"));
  try {
    const agent = await makeAgent(project.id, "sequential");
    await runEdgeJob(agent.id, project.id, `sha256:${"c".repeat(64)}`);
    await runEdgeJob(agent.id, project.id, `sha256:${"d".repeat(64)}`);

    const releases = (
      await pool.query(
        `SELECT status FROM releases WHERE project_id = $1 ORDER BY started_at, id`,
        [project.id]
      )
    ).rows as { status: string }[];
    assert.equal(releases.length, 2);
    assert.deepEqual(releases.map((r) => r.status), ["stopped", "active"]);
  } finally {
    await cleanupProject(project.id);
  }
});

test("rollback runs on the inherited edge agent and activates a release from the rollback digest", async () => {
  if (!(await gateDb("agents/edgeActivation.db.unit.test.ts", dbAvailable))) return;
  const project = await makeProject(uniqueName("rollback"));
  try {
    const agent = await makeAgent(project.id, "owner");
    const original = await runEdgeJob(agent.id, project.id, `sha256:${"e".repeat(64)}`);
    const originalReleaseId = (
      await pool.query(`SELECT release_id FROM deployments WHERE id = $1`, [original])
    ).rows[0].release_id as string;

    const rollback = await createDeployment({
      projectId: project.id,
      trigger: "rollback",
      idempotencyKey: null,
      rollbackReleaseId: originalReleaseId,
      targetAgentId: null,
    });
    assert.ok(rollback);
    const rollbackId = (rollback as { id: string; target_agent_id: string | null }).id;
    // Inheritance: the rollback deployment runs where the superseded release ran.
    assert.equal((rollback as { target_agent_id: string | null }).target_agent_id, agent.id);

    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    const done = await completeAgentJob(agent.id, (claimed as { id: string }).id, {
      outcome: "succeeded",
      imageDigest: `sha256:${"e".repeat(64)}`,
      containerPort: 3000,
    });
    assert.equal(done.result, "completed");
    void rollbackId;

    const rollbackDep = (
      await pool.query(`SELECT status, release_id, rollback_release_id FROM deployments WHERE id = $1`, [
        rollbackId,
      ])
    ).rows[0] as { status: string; release_id: string; rollback_release_id: string };
    assert.equal(rollbackDep.status, "active");
    assert.notEqual(rollbackDep.release_id, originalReleaseId);

    const newRelease = (
      await pool.query(`SELECT image_digest, supersedes_release_id FROM releases WHERE id = $1`, [
        rollbackDep.release_id,
      ])
    ).rows[0] as { image_digest: string; supersedes_release_id: string | null };
    assert.equal(newRelease.image_digest, `sha256:${"e".repeat(64)}`);
    assert.equal(newRelease.supersedes_release_id, originalReleaseId);

    const priorStatus = (
      await pool.query(`SELECT status FROM releases WHERE id = $1`, [originalReleaseId])
    ).rows[0].status as string;
    assert.equal(priorStatus, "stopped");
  } finally {
    await cleanupProject(project.id);
  }
});

test("rollback jobs skip the edge build phase and use the execute phase", async () => {
  if (!(await gateDb("agents/edgeActivation.db.unit.test.ts", dbAvailable))) return;
  const project = await makeProject(uniqueName("rollbackphase"));
  try {
    const agent = await makeAgent(project.id, "phaser");
    const source = await createDeployment({ projectId: project.id, trigger: "manual", idempotencyKey: null });
    assert.ok(source);
    const release = await createRelease({
      deploymentId: (source as { id: string }).id,
      projectId: project.id,
      imageRepository: IMAGE_REPO,
      imageDigest: `sha256:${"f".repeat(64)}`,
      commitSha: "a".repeat(40),
      branch: "main",
      supersedesReleaseId: null,
    });
    await cancelDeployment((source as { id: string }).id);
    const rollback = await createDeployment({
      projectId: project.id,
      trigger: "rollback",
      idempotencyKey: null,
      rollbackReleaseId: release.id,
      targetAgentId: agent.id,
    });
    assert.ok(rollback);
    const job = (
      await pool.query(`SELECT job_phase, claimed_agent_id FROM deployment_jobs WHERE deployment_id = $1`, [
        (rollback as { id: string }).id,
      ])
    ).rows[0] as { job_phase: string; claimed_agent_id: string | null };
    assert.equal(job.job_phase, "execute");
  } finally {
    await cleanupProject(project.id);
  }
});
