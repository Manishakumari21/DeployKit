

import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import {
  claimNextEdgeBuildJob,
  completeEdgeBuildPhase,
  demoteEdgeBuildJobsWhenDisabled,
  extendEdgeBuildLease,
  failEdgeBuildPhase,
  EdgeBuildError,
} from "./deploymentQueue.js";
import { claimAgentJob } from "../agents/agentJobService.js";
import { gateDb } from "../test/dbGate.js";

const SUITE = "workers/edgeBuild.db.unit.test.ts";
const WORKER = `edge-build-worker-${Math.random().toString(36).slice(2, 10)}`;
const OTHER_WORKER = `edge-build-worker-b-${Math.random().toString(36).slice(2, 10)}`;

const VALID_DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const REPO = "deploykit-registry:5000/deploykit/project-deadbeef";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

async function schemaReady(): Promise<boolean> {
  try {
    const r = await pool.query(
      `SELECT to_regclass('public.deployment_jobs') IS NOT NULL AS t`
    );
    if (r.rows[0].t !== true) return false;
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'deployment_jobs' AND column_name = 'job_phase'`
    );
    return (cols.rowCount ?? 0) === 1;
  } catch {
    return false;
  }
}

async function ready(): Promise<boolean> {
  return gateDb(SUITE, async () => {
    if (!(await dbAvailable())) return false;
    return schemaReady();
  });
}

interface Fixture {
  projectId: string;
  deploymentId: string;
  jobId: string;
  agentId: string;
}

async function createEdgeFixture(tag: string): Promise<Fixture> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const project = await pool.query(
    `INSERT INTO projects (name, repository_url, branch)
     VALUES ($1, 'https://github.com/acme/app.git', 'main') RETURNING id`,
    [`edge-build-${tag}-${stamp}`]
  );
  const projectId = project.rows[0].id;

  const agent = await pool.query(
    `INSERT INTO agents (project_id, name, status)
     VALUES ($1, $2, 'pending') RETURNING id`,
    [projectId, `agent-${tag}-${stamp}`]
  );
  const agentId = agent.rows[0].id;

  const deployment = await pool.query(
    `INSERT INTO deployments (project_id, status, trigger, branch, target_agent_id)
     VALUES ($1, 'queued', 'manual', 'main', $2) RETURNING id`,
    [projectId, agentId]
  );
  const deploymentId = deployment.rows[0].id;

  const job = await pool.query(
    `INSERT INTO deployment_jobs (deployment_id, status, job_phase)
     VALUES ($1, 'queued', 'build') RETURNING id`,
    [deploymentId]
  );

  return { projectId, deploymentId, jobId: job.rows[0].id, agentId };
}

async function cleanup(f: Fixture): Promise<void> {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [f.projectId]);
}

async function jobRow(jobId: string): Promise<Record<string, unknown>> {
  const r = await pool.query(
    `SELECT status, job_phase, attempts, max_attempts, build_attempts,
            max_build_attempts, locked_by, lease_token, claimed_agent_id
     FROM deployment_jobs WHERE id = $1`,
    [jobId]
  );
  return r.rows[0];
}

test("a newly created edge-targeted deployment starts in the build phase only when enabled", async () => {
  if (!(await ready())) return;
  const { createDeployment } = await import("../services/deploymentService.js");
  const { createAgent } = await import("../agents/agentService.js");
  const { isEdgeBuildEnabled } = await import("./deploymentQueue.js");
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const mkProject = async (tag: string) => {
    const r = await pool.query(
      `INSERT INTO projects (name, repository_url, branch)
       VALUES ($1, 'https://github.com/acme/app.git', 'main') RETURNING id`,
      [`edge-phase-${tag}-${stamp}`]
    );
    return r.rows[0].id as string;
  };
  // Separate projects: the per-project concurrency guard allows only one
  // non-terminal deployment at a time.
  const edgeProjectId = await mkProject("edge-off");
  const onProjectId = await mkProject("edge-on");
  const centralProjectId = await mkProject("central");
  const phaseOf = async (deploymentId: string) => {
    const r = await pool.query(
      `SELECT j.job_phase FROM deployment_jobs j WHERE j.deployment_id = $1`,
      [deploymentId]
    );
    return r.rows[0].job_phase as string;
  };
  const saved = process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
  try {
    // Flag OFF (default): the build phase must not engage, so edge deployments
    // stay in the execution phase and remain claimable by the agent, which
    // then fails closed with EDGE_IMAGE_CONTRACT_MISSING as before. Creating
    // them in 'build' while disabled strands the job: no worker claims a build
    // job and the agent refuses anything that is not 'execute'.
    delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
    assert.equal(isEdgeBuildEnabled(), false);
    const agentOff = await createAgent(edgeProjectId, `phase-off-${stamp}`);
    const off = await createDeployment({
      projectId: edgeProjectId,
      trigger: "manual",
      idempotencyKey: null,
      targetAgentId: agentOff.id,
    });
    assert.ok(off);
    assert.equal(
      await phaseOf(off.id),
      "execute",
      "with the flag off an edge deployment must stay claimable by the agent"
    );

    // Flag ON: the deployment must start in the build phase, otherwise the
    // build worker (which requires job_phase = 'build') can never claim it and
    // the image contract can never be satisfied.
    process.env.DEPLOYKIT_EDGE_BUILD_ENABLED = "true";
    assert.equal(isEdgeBuildEnabled(), true);
    const agentOn = await createAgent(onProjectId, `phase-on-${stamp}`);
    const on = await createDeployment({
      projectId: onProjectId,
      trigger: "manual",
      idempotencyKey: null,
      targetAgentId: agentOn.id,
    });
    assert.ok(on);
    assert.equal(
      await phaseOf(on.id),
      "build",
      "with the flag on an edge deployment must start in the build phase"
    );

    // Central deployments are never affected by the flag.
    const central = await createDeployment({
      projectId: centralProjectId,
      trigger: "manual",
      idempotencyKey: null,
    });
    assert.ok(central);
    assert.equal(
      await phaseOf(central.id),
      "execute",
      "central deployments must stay in the execution phase"
    );
  } finally {
    if (saved === undefined) delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
    else process.env.DEPLOYKIT_EDGE_BUILD_ENABLED = saved;
    await pool.query(`DELETE FROM projects WHERE id = ANY($1)`, [
      [edgeProjectId, onProjectId, centralProjectId],
    ]);
  }
});

test("build phase is opt-in via feature flag", () => {
  const saved = process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
  try {
    delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;


    assert.equal(process.env.DEPLOYKIT_EDGE_BUILD_ENABLED, undefined);
  } finally {
    if (saved === undefined) delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
    else process.env.DEPLOYKIT_EDGE_BUILD_ENABLED = saved;
  }
});

test("edge build claim is exclusive and increments only build_attempts", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("claim");
  try {
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.ok(claimed, "expected to claim the build job");


    const second = await claimNextEdgeBuildJob(OTHER_WORKER, 30_000);
    assert.equal(second, null, "a second worker must not claim a leased build job");

    const row = await jobRow(f.jobId);
    assert.equal(row.status, "running");
    assert.equal(row.job_phase, "build");
    assert.equal(row.build_attempts, 1);

    assert.equal(row.attempts, 0);
    assert.ok(row.lease_token, "claim must mint a lease token");
    assert.equal(row.claimed_agent_id, null);

    const dep = await pool.query(
      `SELECT status, started_at FROM deployments WHERE id = $1`,
      [f.deploymentId]
    );
    assert.equal(dep.rows[0].status, "cloning");
  } finally {
    await cleanup(f);
  }
});

test("build attempts never consume the execution budget or audit table", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("budget");
  try {
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.ok(claimed);

    const attempts = await pool.query(
      `SELECT COUNT(*)::int AS n FROM deployment_attempts WHERE deployment_id = $1`,
      [f.deploymentId]
    );
    assert.equal(attempts.rows[0].n, 0, "build must not write deployment_attempts");

    const row = await jobRow(f.jobId);
    assert.equal(row.attempts, 0);
  } finally {
    await cleanup(f);
  }
});

test("agent cannot claim a job that is still in the build phase", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("agent-excluded");
  try {
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.ok(claimed, "worker should hold the build job");

    const agentJob = await claimAgentJob(f.agentId);
    assert.equal(
      agentJob,
      null,
      "agent must not claim a build-phase job (no race with the worker)"
    );
  } finally {
    await cleanup(f);
  }
});

test("worker cannot re-claim an edge job that is in the execution phase", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("worker-excluded");
  try {
    await pool.query(
      `UPDATE deployment_jobs SET job_phase = 'execute' WHERE id = $1`,
      [f.jobId]
    );
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.equal(claimed, null, "build claim must ignore execution-phase jobs");
  } finally {
    await cleanup(f);
  }
});

test("agent may claim after a successful build hand-off", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("handoff");
  try {
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.ok(claimed);

    const outcome = await completeEdgeBuildPhase(
      f.jobId,
      f.deploymentId,
      WORKER,
      claimed.leaseToken,
      {
        imageRepository: REPO,
        imageDigest: VALID_DIGEST,
        commitSha: "c".repeat(40),
      }
    );
    assert.equal(outcome, "completed");

    const row = await jobRow(f.jobId);
    assert.equal(row.status, "queued");
    assert.equal(row.job_phase, "execute");
    assert.equal(row.locked_by, null);
    assert.equal(row.lease_token, null);

    assert.equal(row.attempts, 0);

    const dep = await pool.query(
      `SELECT status, image_repository, image_digest FROM deployments WHERE id = $1`,
      [f.deploymentId]
    );
    assert.equal(dep.rows[0].status, "queued");
    assert.equal(dep.rows[0].image_digest, VALID_DIGEST);
    assert.equal(dep.rows[0].image_repository, REPO);


    const agentJob = await claimAgentJob(f.agentId);
    assert.ok(agentJob, "agent should be able to claim the handed-off job");
    assert.equal(agentJob.image?.digest, VALID_DIGEST);
  } finally {
    await cleanup(f);
  }
});

test("build hand-off never creates a release row", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("no-release");
  try {
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.ok(claimed);
    await pool.query(
      `UPDATE deployments SET status = 'pushing' WHERE id = $1`,
      [f.deploymentId]
    );

    await completeEdgeBuildPhase(
      f.jobId,
      f.deploymentId,
      WORKER,
      claimed.leaseToken,
      {
        imageRepository: REPO,
        imageDigest: VALID_DIGEST,
        commitSha: "c".repeat(40),
      }
    );

    const releases = await pool.query(
      `SELECT COUNT(*)::int AS n FROM releases WHERE deployment_id = $1`,
      [f.deploymentId]
    );
    assert.equal(releases.rows[0].n, 0, "edge build must not create a release");
  } finally {
    await cleanup(f);
  }
});

test("hand-off rejects a stale lease token", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("stale-token");
  try {
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.ok(claimed);

    await assert.rejects(
      completeEdgeBuildPhase(
        f.jobId,
        f.deploymentId,
        WORKER,
        "00000000-0000-0000-0000-000000000000",
        {
          imageRepository: REPO,
          imageDigest: VALID_DIGEST,
          commitSha: "c".repeat(40),
        }
      ),
      (error: unknown) =>
        error instanceof EdgeBuildError && error.code === "BUILD_LEASE_NOT_OWNED"
    );
  } finally {
    await cleanup(f);
  }
});

test("hand-off rejects another worker's token", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("wrong-owner");
  try {
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.ok(claimed);

    await assert.rejects(
      completeEdgeBuildPhase(
        f.jobId,
        f.deploymentId,
        OTHER_WORKER,
        claimed.leaseToken,
        {
          imageRepository: REPO,
          imageDigest: VALID_DIGEST,
          commitSha: "c".repeat(40),
        }
      ),
      (error: unknown) =>
        error instanceof EdgeBuildError && error.code === "BUILD_LEASE_NOT_OWNED"
    );
  } finally {
    await cleanup(f);
  }
});

test("hand-off fails closed on malformed or untrusted image metadata", async () => {
  if (!(await ready())) return;

  const bad: { digest: string; repo: string }[] = [
    { digest: "not-a-digest", repo: REPO },
    { digest: "sha256:zzz", repo: REPO },
    { digest: "", repo: REPO },
    { digest: "latest", repo: REPO },

    { digest: VALID_DIGEST, repo: "deploykit/project-deadbeef" },
  ];

  for (const item of bad) {
    const f = await createEdgeFixture("bad-image");
    try {
      const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
      assert.ok(claimed);
      await assert.rejects(
        completeEdgeBuildPhase(f.jobId, f.deploymentId, WORKER, claimed.leaseToken, {
          imageRepository: item.repo,
          imageDigest: item.digest,
          commitSha: "c".repeat(40),
        }),
        (error: unknown) => error instanceof EdgeBuildError,
        `expected rejection for digest=${item.digest} repo=${item.repo}`
      );
    } finally {
      await cleanup(f);
    }
  }
});

test("duplicate build completion is first-write-wins and idempotent", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("duplicate");
  try {
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.ok(claimed);

    const first = await completeEdgeBuildPhase(
      f.jobId,
      f.deploymentId,
      WORKER,
      claimed.leaseToken,
      {
        imageRepository: REPO,
        imageDigest: VALID_DIGEST,
        commitSha: "c".repeat(40),
      }
    );
    assert.equal(first, "completed");


    const dep = await pool.query(
      `UPDATE deployments SET image_digest = $2 WHERE id = $1 RETURNING image_digest`,
      [f.deploymentId, VALID_DIGEST]
    );
    assert.equal(dep.rows[0].image_digest, VALID_DIGEST);
  } finally {
    await cleanup(f);
  }
});

test("build failure retries within the build budget and never touches attempts", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("retry");
  try {
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.ok(claimed);

    const outcome = await failEdgeBuildPhase(
      f.jobId,
      f.deploymentId,
      WORKER,
      claimed.leaseToken,
      "build exploded",
      "BUILD_FAILED"
    );
    assert.equal(outcome, "retrying");

    const row = await jobRow(f.jobId);
    assert.equal(row.status, "queued");
    assert.equal(row.job_phase, "build");
    assert.equal(row.attempts, 0, "execution budget must stay untouched");
    assert.equal(row.lease_token, null);
  } finally {
    await cleanup(f);
  }
});

test("build failure dead-letters once the build budget is exhausted", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("dead-letter");
  try {
    await pool.query(
      `UPDATE deployment_jobs SET max_build_attempts = 1 WHERE id = $1`,
      [f.jobId]
    );
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.ok(claimed);

    const outcome = await failEdgeBuildPhase(
      f.jobId,
      f.deploymentId,
      WORKER,
      claimed.leaseToken,
      "build exploded",
      "BUILD_FAILED"
    );
    assert.equal(outcome, "failed");

    const row = await jobRow(f.jobId);
    assert.equal(row.status, "failed");
    assert.ok(
      (row.build_attempts as number) >= (row.max_build_attempts as number),
      "build budget must be poisoned"
    );

    assert.equal(row.attempts, 0);


    const again = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.equal(again, null);
  } finally {
    await cleanup(f);
  }
});

test("build lease renewal is token-fenced", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("renew");
  try {
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.ok(claimed);

    assert.equal(
      await extendEdgeBuildLease(f.jobId, WORKER, claimed.leaseToken, 30_000),
      true
    );
    assert.equal(
      await extendEdgeBuildLease(
        f.jobId,
        WORKER,
        "00000000-0000-0000-0000-000000000000",
        30_000
      ),
      false
    );
  } finally {
    await cleanup(f);
  }
});

test("agent may claim an execute-phase job with no image and still fail closed", async () => {
  if (!(await ready())) return;
  const f = await createEdgeFixture("null-image-execute");
  try {






    await pool.query(
      `UPDATE deployment_jobs SET job_phase = 'execute' WHERE id = $1`,
      [f.jobId]
    );

    const job = await claimAgentJob(f.agentId);
    assert.ok(
      job,
      "an execute-phase job must be claimable even without a trusted image"
    );
    assert.equal(
      job.image,
      null,
      "no trusted image must surface as null so the executor fails closed"
    );
  } finally {
    await cleanup(f);
  }
});

test("lease recovery is phase-aware: build jobs retry as builds, agent jobs stay executable", async () => {
  if (!(await ready())) return;

  const { recoverExpiredJobs } = await import("./deploymentQueue.js");
  const build = await createEdgeFixture("recover-build");
  const agentOwned = await createEdgeFixture("recover-agent");

  try {
    const claimed = await claimNextEdgeBuildJob(WORKER, 30_000);
    assert.ok(claimed);
    await pool.query(
      `UPDATE deployment_jobs SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE id = $1`,
      [build.jobId]
    );


    await pool.query(
      `UPDATE deployment_jobs
       SET status = 'running', locked_by = $2, claimed_agent_id = $3,
           job_phase = 'execute',
           lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE id = $1`,
      [agentOwned.jobId, agentOwned.agentId, agentOwned.agentId]
    );

    await recoverExpiredJobs();



    const buildRow = await jobRow(build.jobId);
    assert.equal(buildRow.status, "queued");
    assert.equal(buildRow.job_phase, "build");
    assert.equal(buildRow.claimed_agent_id, null);





    const agentRow = await jobRow(agentOwned.jobId);
    assert.equal(agentRow.status, "queued");
    assert.equal(agentRow.job_phase, "execute");

    const reclaimed = await claimAgentJob(agentOwned.agentId);
    assert.ok(
      reclaimed,
      "an expired agent lease must be reclaimable by the same agent"
    );
    assert.equal(reclaimed.id, agentOwned.jobId);
  } finally {
    await cleanup(build);
    await cleanup(agentOwned);
  }
});
test("flag enabled: demotion is a no-op and writes no events", async () => {
  if (!(await ready())) return;
  const saved = process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
  const f = await createEdgeFixture("demote-on");
  try {
    process.env.DEPLOYKIT_EDGE_BUILD_ENABLED = "true";
    const demoted = await demoteEdgeBuildJobsWhenDisabled();
    assert.deepEqual(demoted, [], "an enabled flag must never demote");
    assert.equal((await jobRow(f.jobId)).job_phase, "build");

    const events = await pool.query(
      `SELECT COUNT(*)::int AS n FROM deployment_events
       WHERE deployment_id = $1 AND event_type = 'deployment.edge_build_demoted'`,
      [f.deploymentId]
    );
    assert.equal(events.rows[0].n, 0, "no event may be written while enabled");
  } finally {
    if (saved === undefined) delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
    else process.env.DEPLOYKIT_EDGE_BUILD_ENABLED = saved;
    await cleanup(f);
  }
});

test("flag disabled: queued build jobs are demoted with durable events", async () => {
  if (!(await ready())) return;
  const saved = process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
  const f = await createEdgeFixture("demote-off");
  try {
    delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
    const before = await pool.query(
      `SELECT image_digest FROM deployments WHERE id = $1`,
      [f.deploymentId]
    );
    assert.equal(before.rows[0].image_digest, null);

    const demoted = await demoteEdgeBuildJobsWhenDisabled();
    assert.ok(
      demoted.includes(f.jobId),
      "the eligible job must be demoted when the flag is off"
    );

    const row = await jobRow(f.jobId);
    assert.equal(row.job_phase, "execute");
    assert.equal(row.status, "queued", "demotion must not change job status");
    assert.equal(row.locked_by, null, "demotion must not take a lease");
    assert.equal(row.lease_token, null);

    // The deployment row itself is untouched, including any image metadata.
    const dep = await pool.query(
      `SELECT status, image_digest, image_repository FROM deployments WHERE id = $1`,
      [f.deploymentId]
    );
    assert.equal(dep.rows[0].status, "queued", "deployment status is not changed");
    assert.equal(dep.rows[0].image_digest, null, "no digest may be fabricated");
    assert.equal(dep.rows[0].image_repository, null);

    const events = await pool.query(
      `SELECT status_from, status_to, message, metadata
       FROM deployment_events
       WHERE deployment_id = $1 AND event_type = 'deployment.edge_build_demoted'`,
      [f.deploymentId]
    );
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0].status_from, "queued");
    assert.equal(events.rows[0].status_to, "queued", "no transition is claimed");
    assert.match(events.rows[0].message, /fails closed without a trusted image/);
    assert.equal(events.rows[0].metadata.reason, "EDGE_BUILD_DISABLED");
    assert.equal(events.rows[0].metadata.previousPhase, "build");
    assert.equal(events.rows[0].metadata.phase, "execute");
    assert.equal(events.rows[0].metadata.jobId, f.jobId);
  } finally {
    if (saved === undefined) delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
    else process.env.DEPLOYKIT_EDGE_BUILD_ENABLED = saved;
    await cleanup(f);
  }
});

test("repeated demotion is idempotent and writes no duplicate events", async () => {
  if (!(await ready())) return;
  const saved = process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
  const f = await createEdgeFixture("demote-idem");
  try {
    delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;

    const first = await demoteEdgeBuildJobsWhenDisabled();
    assert.ok(
      first.includes(f.jobId),
      "the first invocation must demote this job"
    );

    // Later invocations must never re-report this job, whatever else exists.
    const second = await demoteEdgeBuildJobsWhenDisabled();
    const third = await demoteEdgeBuildJobsWhenDisabled();
    assert.ok(
      !second.includes(f.jobId) && !third.includes(f.jobId),
      "an already demoted job must not be demoted again"
    );

    const events = await pool.query(
      `SELECT COUNT(*)::int AS n FROM deployment_events
       WHERE deployment_id = $1 AND event_type = 'deployment.edge_build_demoted'`,
      [f.deploymentId]
    );
    assert.equal(events.rows[0].n, 1, "only one event may ever be recorded");
    assert.equal((await jobRow(f.jobId)).job_phase, "execute");
  } finally {
    if (saved === undefined) delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
    else process.env.DEPLOYKIT_EDGE_BUILD_ENABLED = saved;
    await cleanup(f);
  }
});

test("demotion leaves running, cancelled, execute-phase and central jobs alone", async () => {
  if (!(await ready())) return;
  const saved = process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
  const running = await createEdgeFixture("demote-running");
  const cancelled = await createEdgeFixture("demote-cancelled");
  const executePhase = await createEdgeFixture("demote-execute");
  const central = await createEdgeFixture("demote-central");
  try {
    // A running build owns a lease; demotion must not steal or alter it.
    await pool.query(
      `UPDATE deployment_jobs
       SET status = 'running',
           locked_by = 'some-other-worker',
           lease_token = gen_random_uuid(),
           lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '30 seconds',
           available_at = CURRENT_TIMESTAMP - INTERVAL '5 seconds',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [running.jobId]
    );
    // A cancelled deployment's job is terminal and must stay that way.
    await pool.query(`UPDATE deployments SET status = 'cancelled' WHERE id = $1`, [
      cancelled.deploymentId,
    ]);
    await pool.query(`UPDATE deployment_jobs SET status = 'cancelled' WHERE id = $1`, [
      cancelled.jobId,
    ]);
    // An already-execute-phase job has nothing to demote.
    await pool.query(`UPDATE deployment_jobs SET job_phase = 'execute' WHERE id = $1`, [
      executePhase.jobId,
    ]);
    // A central (non edge-targeted) deployment is never an edge build job.
    await pool.query(`UPDATE deployments SET target_agent_id = NULL WHERE id = $1`, [
      central.deploymentId,
    ]);

    const leaseBefore = (
      await pool.query(
        `SELECT locked_by, lease_token, lease_expires_at, available_at
         FROM deployment_jobs WHERE id = $1`,
        [running.jobId]
      )
    ).rows[0];

    delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
    const demoted = await demoteEdgeBuildJobsWhenDisabled();
    const mine = [running.jobId, cancelled.jobId, executePhase.jobId, central.jobId];
    for (const jobId of mine) {
      assert.ok(
        !demoted.includes(jobId),
        "none of these jobs is eligible for demotion"
      );
    }

    assert.equal((await jobRow(running.jobId)).job_phase, "build");
    assert.equal((await jobRow(cancelled.jobId)).job_phase, "build");
    assert.equal((await jobRow(cancelled.jobId)).status, "cancelled");
    assert.equal((await jobRow(executePhase.jobId)).job_phase, "execute");
    assert.equal((await jobRow(central.jobId)).job_phase, "build");

    const leaseAfter = (
      await pool.query(
        `SELECT locked_by, lease_token, lease_expires_at, available_at
         FROM deployment_jobs WHERE id = $1`,
        [running.jobId]
      )
    ).rows[0];
    assert.deepEqual(
      leaseAfter,
      leaseBefore,
      "a running job's lease fields must be byte-identical after demotion"
    );

    for (const f of [running, cancelled, executePhase, central]) {
      const events = await pool.query(
        `SELECT COUNT(*)::int AS n FROM deployment_events
         WHERE deployment_id = $1 AND event_type = 'deployment.edge_build_demoted'`,
        [f.deploymentId]
      );
      assert.equal(events.rows[0].n, 0);
    }
  } finally {
    if (saved === undefined) delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
    else process.env.DEPLOYKIT_EDGE_BUILD_ENABLED = saved;
    await cleanup(running);
    await cleanup(cancelled);
    await cleanup(executePhase);
    await cleanup(central);
  }
});

test("a demoted job still fails closed: the agent claims it and finds no image", async () => {
  if (!(await ready())) return;
  const saved = process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
  const f = await createEdgeFixture("demote-failclosed");
  try {
    delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
    const demoted = await demoteEdgeBuildJobsWhenDisabled();
    assert.ok(demoted.includes(f.jobId), "this job must be demoted");

    // Demotion must not invent image metadata.
    const dep = await pool.query(
      `SELECT image_repository, image_digest FROM deployments WHERE id = $1`,
      [f.deploymentId]
    );
    assert.equal(dep.rows[0].image_repository, null);
    assert.equal(dep.rows[0].image_digest, null);

    // The agent can now claim it (execute phase), and gets image = null,
    // which the executor rejects with EDGE_IMAGE_CONTRACT_MISSING.
    const claimed = await claimAgentJob(f.agentId);
    assert.ok(claimed, "a demoted job must be claimable by the agent");
    assert.equal(claimed.id, f.jobId);
    assert.equal(claimed.image, null, "no trusted image may be fabricated");
  } finally {
    if (saved === undefined) delete process.env.DEPLOYKIT_EDGE_BUILD_ENABLED;
    else process.env.DEPLOYKIT_EDGE_BUILD_ENABLED = saved;
    await cleanup(f);
  }
});
