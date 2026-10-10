import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import pool from "../db/database.js";
import { createAgent, createEnrollmentCredential } from "./agentService.js";
import { authenticateAgentToken } from "./agentAuthentication.js";
import {
  AgentJobError,
  claimAgentJob,
  completeAgentJob,
  failAgentJob,
  heartbeatAgentJob,
} from "./agentJobService.js";
import { createDeployment } from "../services/deploymentService.js";
import { createRelease } from "../services/releaseService.js";
import { claimNextJob } from "../workers/deploymentQueue.js";
import { AgentError } from "./agentService.js";
import {
  claimAgentJobController,
  completeAgentJobController,
  failAgentJobController,
  heartbeatAgentJobController,
} from "../controllers/agentController.js";
import { createDeploymentController } from "../controllers/deploymentController.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.agents') AS agents,
              to_regclass('public.deployment_jobs') AS jobs`
    );
    return check.rows[0].agents !== null && check.rows[0].jobs !== null;
  } catch {
    return false;
  }
}

function uniqueName(tag: string): string {
  const rand = Math.floor(Math.random() * 1_000_000);
  return `edge123-${tag}-${Date.now()}-${rand}`;
}

async function makeProject(name: string): Promise<{ id: string }> {
  const row = (
    await pool.query(
      `INSERT INTO projects (name, repository_url, branch)
       VALUES ($1, 'https://github.com/acme/app.git', 'main')
       RETURNING id`,
      [name]
    )
  ).rows[0] as { id: string };
  return row;
}

async function makeAgent(projectId: string, tag: string) {
  const agent = await createAgent(projectId, `edge-${tag}`);
  const cred = await createEnrollmentCredential(agent.id);
  const context = await authenticateAgentToken(`Bearer ${cred.token}`);
  assert.ok(context);
  return { agent, token: cred.token, context };
}

async function makeTargetedDeployment(projectId: string, agentId: string) {
  const deployment = await createDeployment({
    projectId,
    trigger: "manual",
    idempotencyKey: null,
    targetAgentId: agentId,
  });
  assert.ok(deployment);
  return deployment as { id: string };
}

async function cleanupProject(projectId: string): Promise<void> {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  res: Response;
}

function fakeRes(): FakeRes {
  const fake = {
    statusCode: 200,
    body: undefined as unknown,
    res: undefined as unknown as Response,
  };
  const res = {
    status(code: number) {
      fake.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      fake.body = payload;
      return res;
    },
  };
  fake.res = res as unknown as Response;
  return fake;
}

function fakeReq(init: {
  headers?: Record<string, string | undefined>;
  body?: unknown;
  params?: Record<string, string>;
  agent?: { agentId: string; projectId: string; credentialId: string };
}): Request {
  return {
    headers: init.headers ?? {},
    header: (_name: string) => undefined,
    body: init.body,
    params: init.params ?? {},
    ...(init.agent === undefined ? {} : { agent: init.agent }),
  } as unknown as Request;
}

test("an agent claims its own project's targeted job", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("claim"));
  try {
    const { agent } = await makeAgent(project.id, "a1");
    const deployment = await makeTargetedDeployment(project.id, agent.id);
    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    assert.equal(claimed.deploymentId, deployment.id);
    assert.equal(claimed.projectId, project.id);
    assert.equal(claimed.agentId, agent.id);
    assert.equal(claimed.attempts, 1);
    assert.ok(Date.parse(claimed.leaseExpiresAt ?? "") > Date.now());
    const job = (
      await pool.query(
        `SELECT status, claimed_agent_id, locked_by, attempts
         FROM deployment_jobs WHERE deployment_id = $1`,
        [deployment.id]
      )
    ).rows[0] as {
      status: string;
      claimed_agent_id: string;
      locked_by: string;
      attempts: number;
    };
    assert.equal(job.status, "running");
    assert.equal(job.claimed_agent_id, agent.id);
    assert.equal(job.locked_by, agent.id);
    assert.equal(job.attempts, 1);
    const dep = (
      await pool.query(`SELECT status FROM deployments WHERE id = $1`, [
        deployment.id,
      ])
    ).rows[0] as { status: string };
    assert.equal(dep.status, "cloning");
  } finally {
    await cleanupProject(project.id);
  }
});

test("another project's agent cannot claim the job", async () => {
  if (!(await dbAvailable())) return;
  const home = await makeProject(uniqueName("home"));
  const away = await makeProject(uniqueName("away"));
  try {
    const owner = await makeAgent(home.id, "owner");
    const stranger = await makeAgent(away.id, "stranger");
    await makeTargetedDeployment(home.id, owner.agent.id);
    assert.equal(await claimAgentJob(stranger.agent.id), null);
    assert.ok(await claimAgentJob(owner.agent.id));
  } finally {
    await cleanupProject(home.id);
    await cleanupProject(away.id);
  }
});

test("an agent cannot claim a job targeted at a different agent", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("twoagents"));
  try {
    const first = await makeAgent(project.id, "first");
    const second = await makeAgent(project.id, "second");
    await makeTargetedDeployment(project.id, first.agent.id);
    assert.equal(await claimAgentJob(second.agent.id), null);
    assert.ok(await claimAgentJob(first.agent.id));
  } finally {
    await cleanupProject(project.id);
  }
});

test("central jobs are invisible to agents and still claimed centrally", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("central"));
  try {
    const { agent } = await makeAgent(project.id, "edge");
    const deployment = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    assert.ok(deployment);
    assert.equal(await claimAgentJob(agent.id), null);
    const claimed = await claimNextJob("central-probe", 30_000);
    assert.ok(claimed);
    assert.equal(claimed.deploymentId, deployment.id);
  } finally {
    await cleanupProject(project.id);
  }
});

test("a revoked agent cannot claim new work", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("revokedclaim"));
  try {
    const { agent } = await makeAgent(project.id, "doomed");
    await makeTargetedDeployment(project.id, agent.id);
    await pool.query(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [
      agent.id,
    ]);
    await assert.rejects(
      claimAgentJob(agent.id),
      (e: unknown) => e instanceof AgentJobError && e.code === "AGENT_REVOKED"
    );
    await assert.rejects(
      claimAgentJob("00000000-0000-0000-0000-000000000000"),
      (e: unknown) => e instanceof AgentJobError && e.code === "AGENT_NOT_FOUND"
    );
  } finally {
    await cleanupProject(project.id);
  }
});

test("an expired lease becomes reclaimable by the same agent", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("reclaim"));
  try {
    const { agent } = await makeAgent(project.id, "re");
    const deployment = await makeTargetedDeployment(project.id, agent.id);
    const first = await claimAgentJob(agent.id);
    assert.ok(first);
    await pool.query(
      `UPDATE deployment_jobs
       SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE deployment_id = $1`,
      [deployment.id]
    );
    const second = await claimAgentJob(agent.id);
    assert.ok(second);
    assert.equal(second.id, first.id);
    assert.equal(second.attempts, 2);
    assert.ok(Date.parse(second.leaseExpiresAt ?? "") > Date.now());
  } finally {
    await cleanupProject(project.id);
  }
});

test("a valid lease cannot be stolen or double-claimed", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("nosteal"));
  const otherProject = await makeProject(uniqueName("nosteal-other"));
  try {
    const { agent } = await makeAgent(project.id, "holder");
    const { agent: rival } = await makeAgent(otherProject.id, "rival");
    await makeTargetedDeployment(project.id, agent.id);
    assert.ok(await claimAgentJob(agent.id));
    assert.equal(await claimAgentJob(rival.id), null);
    assert.equal(await claimAgentJob(agent.id), null);
  } finally {
    await cleanupProject(project.id);
    await cleanupProject(otherProject.id);
  }
});

test("concurrent claims converge on exactly one winner", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("race"));
  try {
    const { agent } = await makeAgent(project.id, "racer");
    const deployment = await makeTargetedDeployment(project.id, agent.id);
    const [first, second] = await Promise.all([
      claimAgentJob(agent.id),
      claimAgentJob(agent.id),
    ]);
    const winners = [first, second].filter(
      (claimed) => claimed !== null
    );
    assert.equal(winners.length, 1);
    assert.equal(winners[0].deploymentId, deployment.id);
    const attempts = (
      await pool.query(
        `SELECT attempts FROM deployment_jobs WHERE deployment_id = $1`,
        [deployment.id]
      )
    ).rows[0].attempts as number;
    assert.equal(attempts, 1);
  } finally {
    await cleanupProject(project.id);
  }
});

test("heartbeat extends only the owning agent's lease", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("hb"));
  const otherProject = await makeProject(uniqueName("hb-other"));
  try {
    const { agent } = await makeAgent(project.id, "holder");
    const { agent: rival } = await makeAgent(otherProject.id, "rival");
    const deployment = await makeTargetedDeployment(project.id, agent.id);
    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    await assert.rejects(
      heartbeatAgentJob(rival.id, claimed.id),
      (e: unknown) => e instanceof AgentJobError && e.code === "LEASE_NOT_OWNED"
    );
    const before = Date.parse(claimed.leaseExpiresAt ?? "");
    await pool.query(
      `UPDATE deployment_jobs
       SET lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '5 seconds'
       WHERE id = $1`,
      [claimed.id]
    );
    const state = await heartbeatAgentJob(agent.id, claimed.id);
    assert.ok(Date.parse(state.job.leaseExpiresAt ?? "") > before - 60_000);
    assert.equal(state.job.id, claimed.id);
    assert.equal(state.deployment.id, deployment.id);
  } finally {
    await cleanupProject(project.id);
    await cleanupProject(otherProject.id);
  }
});

test("completion records success without faking activation", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("complete"));
  try {
    const { agent } = await makeAgent(project.id, "finisher");
    const deployment = await makeTargetedDeployment(project.id, agent.id);
    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    const done = await completeAgentJob(agent.id, claimed.id, {
      outcome: "succeeded",
      imageDigest: `sha256:${"d".repeat(64)}`,
      commitSha: "e".repeat(40),
    });
    assert.equal(done.outcome, "succeeded");
    assert.equal(done.result, "completed");
    assert.equal(done.jobStatus, "succeeded");
    assert.notEqual(done.deploymentStatus, "active");
    const events = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM deployment_events
         WHERE deployment_id = $1 AND event_type = 'deployment.agent_completed'`,
        [deployment.id]
      )
    ).rows[0].n as number;
    assert.equal(events, 1);
    const again = await completeAgentJob(agent.id, claimed.id, {
      outcome: "succeeded",
    });
    assert.equal(again.result, "completed");
    const eventsAfter = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM deployment_events
         WHERE deployment_id = $1 AND event_type = 'deployment.agent_completed'`,
        [deployment.id]
      )
    ).rows[0].n as number;
    assert.equal(eventsAfter, 1);
  } finally {
    await cleanupProject(project.id);
  }
});

test("completion is rejected for non-owners and stale leases", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("complete-no"));
  const otherProject = await makeProject(uniqueName("complete-no-other"));
  try {
    const { agent } = await makeAgent(project.id, "holder");
    const { agent: rival } = await makeAgent(otherProject.id, "rival");
    const deployment = await makeTargetedDeployment(project.id, agent.id);
    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    await assert.rejects(
      completeAgentJob(rival.id, claimed.id, { outcome: "succeeded" }),
      (e: unknown) => e instanceof AgentJobError && e.code === "LEASE_NOT_OWNED"
    );
    await pool.query(
      `UPDATE deployment_jobs SET status = 'queued' WHERE id = $1`,
      [claimed.id]
    );
    await assert.rejects(
      completeAgentJob(agent.id, claimed.id, { outcome: "succeeded" }),
      (e: unknown) => e instanceof AgentJobError && e.code === "LEASE_STALE"
    );
  } finally {
    await cleanupProject(project.id);
    await cleanupProject(otherProject.id);
  }
});

test("reported failures reuse retry then terminal semantics", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("fail"));
  const terminalProject = await makeProject(uniqueName("fail-terminal"));
  try {
    const { agent } = await makeAgent(project.id, "unlucky");
    const deployment = await makeTargetedDeployment(project.id, agent.id);
    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    const retrying = await failAgentJob(agent.id, claimed.id, {
      errorMessage: "container exited 1",
    });
    assert.equal(retrying.outcome, "failed");
    assert.equal(retrying.result, "retrying");
    assert.equal(retrying.jobStatus, "queued");

    const { agent: doomed } = await makeAgent(terminalProject.id, "doomed");
    const terminalDep = await makeTargetedDeployment(terminalProject.id, doomed.id);
    await pool.query(
      `UPDATE deployment_jobs SET max_attempts = 1
       WHERE deployment_id = $1`,
      [terminalDep.id]
    );
    const terminalClaim = await claimAgentJob(doomed.id);
    assert.ok(terminalClaim);
    const terminal = await completeAgentJob(doomed.id, terminalClaim.id, {
      outcome: "failed",
      errorCode: "RUNTIME_FAILED",
      errorMessage: "container exited 1",
    });
    assert.equal(terminal.result, "failed");
    assert.equal(terminal.jobStatus, "failed");
    assert.equal(terminal.deploymentStatus, "failed");
  } finally {
    await cleanupProject(project.id);
    await cleanupProject(terminalProject.id);
  }
});

test("failure reporting is rejected for non-owners", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("fail-no"));
  const otherProject = await makeProject(uniqueName("fail-no-other"));
  try {
    const { agent } = await makeAgent(project.id, "holder");
    const { agent: rival } = await makeAgent(otherProject.id, "rival");
    await makeTargetedDeployment(project.id, agent.id);
    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    await assert.rejects(
      failAgentJob(rival.id, claimed.id, { errorMessage: "nope" }),
      (e: unknown) => e instanceof AgentJobError && e.code === "LEASE_NOT_OWNED"
    );
  } finally {
    await cleanupProject(project.id);
    await cleanupProject(otherProject.id);
  }
});

test("target validation rejects unknown, cross-project, and revoked agents", async () => {
  if (!(await dbAvailable())) return;
  const home = await makeProject(uniqueName("t-home"));
  const away = await makeProject(uniqueName("t-away"));
  try {
    const { agent: foreign } = await makeAgent(away.id, "foreign");
    await assert.rejects(
      createDeployment({
        projectId: home.id,
        trigger: "manual",
        idempotencyKey: null,
        targetAgentId: "00000000-0000-0000-0000-000000000000",
      }),
      (e: unknown) => e instanceof AgentError && e.code === "TARGET_AGENT_NOT_FOUND"
    );
    await assert.rejects(
      createDeployment({
        projectId: home.id,
        trigger: "manual",
        idempotencyKey: null,
        targetAgentId: foreign.id,
      }),
      (e: unknown) =>
        e instanceof AgentError && e.code === "TARGET_AGENT_PROJECT_MISMATCH"
    );
    const { agent: local } = await makeAgent(home.id, "local");
    await pool.query(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [
      local.id,
    ]);
    await assert.rejects(
      createDeployment({
        projectId: home.id,
        trigger: "manual",
        idempotencyKey: null,
        targetAgentId: local.id,
      }),
      (e: unknown) => e instanceof AgentError && e.code === "TARGET_AGENT_REVOKED"
    );
    const ok = await createDeployment({
      projectId: away.id,
      trigger: "manual",
      idempotencyKey: null,
      targetAgentId: foreign.id,
    });
    assert.equal(ok?.target_agent_id, foreign.id);
  } finally {
    await cleanupProject(home.id);
    await cleanupProject(away.id);
  }
});

test("claim and job endpoints expose no secrets", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("secrets"));
  try {
    const { agent, token } = await makeAgent(project.id, "quiet");
    const deployment = await makeTargetedDeployment(project.id, agent.id);
    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    const state = await heartbeatAgentJob(agent.id, claimed.id);
    const done = await completeAgentJob(agent.id, claimed.id, {
      outcome: "succeeded",
    });
    const second = await makeTargetedDeployment(project.id, agent.id);
    const claimed2 = await claimAgentJob(agent.id);
    assert.ok(claimed2);
    assert.equal(claimed2.deploymentId, second.id);
    const failed = await failAgentJob(agent.id, claimed2.id, {
      errorMessage: "container exited 1",
    });
    assert.equal(failed.result, "retrying");
    for (const payload of [claimed, state, done, failed]) {
      const serialized = JSON.stringify(payload);
      assert.ok(!serialized.includes(token));
      assert.match(serialized, /^((?!token|password|secret|session|cookie).)*$/i);
    }
    assert.deepEqual(Object.keys(claimed).sort(), [
      "agentId",
      "attempts",
      "branch",
      "commitSha",
      "deploymentId",
      "id",
      "image",
      "leaseExpiresAt",
      "maxAttempts",
      "projectId",
    ]);

    assert.equal(claimed.image, null);
  } finally {
    await cleanupProject(project.id);
  }
});

test("claim endpoint returns a clean empty result when no work exists", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("empty"));
  try {
    const { context } = await makeAgent(project.id, "idle");
    const req = fakeReq({ headers: {}, agent: context });
    const fake = fakeRes();
    await claimAgentJobController(req, fake.res);
    assert.equal(fake.statusCode, 200);
    assert.deepEqual(fake.body, { job: null });
    const anon = fakeRes();
    await claimAgentJobController(fakeReq({ headers: {} }), anon.res);
    assert.equal(anon.statusCode, 401);
  } finally {
    await cleanupProject(project.id);
  }
});

test("job endpoints validate input and map errors to status codes", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("mapping"));
  const otherProject = await makeProject(uniqueName("mapping-other"));
  try {
    const owner = await makeAgent(project.id, "owner");
    const rivalMade = await makeAgent(otherProject.id, "rival");
    const context = rivalMade.context;
    const deployment = await makeTargetedDeployment(project.id, owner.agent.id);
    const claimed = await claimAgentJob(owner.agent.id);
    assert.ok(claimed);
    const ownerContext = await authenticateAgentToken(`Bearer ${owner.token}`);
    assert.ok(ownerContext);

    const badId = fakeRes();
    await heartbeatAgentJobController(
      fakeReq({ headers: {}, params: { jobId: "not-a-uuid" }, agent: ownerContext }),
      badId.res
    );
    assert.equal(badId.statusCode, 400);

    const unknown = fakeRes();
    await heartbeatAgentJobController(
      fakeReq({
        headers: {},
        params: { jobId: "00000000-0000-0000-0000-000000000000" },
        agent: ownerContext,
      }),
      unknown.res
    );
    assert.equal(unknown.statusCode, 404);

    const stolen = fakeRes();
    await heartbeatAgentJobController(
      fakeReq({ headers: {}, params: { jobId: claimed.id }, agent: context }),
      stolen.res
    );
    assert.equal(stolen.statusCode, 403);

    const badBody = fakeRes();
    await completeAgentJobController(
      fakeReq({
        headers: {},
        params: { jobId: claimed.id },
        body: { outcome: "exploded" },
        agent: ownerContext,
      }),
      badBody.res
    );
    assert.equal(badBody.statusCode, 400);

    const missingMessage = fakeRes();
    await completeAgentJobController(
      fakeReq({
        headers: {},
        params: { jobId: claimed.id },
        body: { outcome: "failed" },
        agent: ownerContext,
      }),
      missingMessage.res
    );
    assert.equal(missingMessage.statusCode, 400);

    const badFail = fakeRes();
    await failAgentJobController(
      fakeReq({
        headers: {},
        params: { jobId: claimed.id },
        body: {},
        agent: ownerContext,
      }),
      badFail.res
    );
    assert.equal(badFail.statusCode, 400);

    const stale = fakeRes();
    await pool.query(`UPDATE deployment_jobs SET status = 'queued' WHERE id = $1`, [
      claimed.id,
    ]);
    await heartbeatAgentJobController(
      fakeReq({ headers: {}, params: { jobId: claimed.id }, agent: ownerContext }),
      stale.res
    );
    assert.equal(stale.statusCode, 409);
  } finally {
    await cleanupProject(project.id);
    await cleanupProject(otherProject.id);
  }
});

test("targeted creation through the controller enforces ownership", async () => {
  if (!(await dbAvailable())) return;
  const home = await makeProject(uniqueName("c-home"));
  const away = await makeProject(uniqueName("c-away"));
  try {
    const { agent: foreign } = await makeAgent(away.id, "foreign");
    const malformed = fakeRes();
    await createDeploymentController(
      fakeReq({ headers: {}, params: { id: home.id }, body: { targetAgentId: "nope" } }),
      malformed.res
    );
    assert.equal(malformed.statusCode, 400);

    const missing = fakeRes();
    await createDeploymentController(
      fakeReq({
        headers: {},
        params: { id: home.id },
        body: { targetAgentId: "00000000-0000-0000-0000-000000000000" },
      }),
      missing.res
    );
    assert.equal(missing.statusCode, 404);

    const crossed = fakeRes();
    await createDeploymentController(
      fakeReq({
        headers: {},
        params: { id: home.id },
        body: { targetAgentId: foreign.id },
      }),
      crossed.res
    );
    assert.equal(crossed.statusCode, 400);

    const created = fakeRes();
    await createDeploymentController(
      fakeReq({
        headers: {},
        params: { id: away.id },
        body: { targetAgentId: foreign.id },
      }),
      created.res
    );
    assert.equal(created.statusCode, 201);
    assert.equal(
      (created.body as { target_agent_id: string }).target_agent_id,
      foreign.id
    );
  } finally {
    await cleanupProject(home.id);
    await cleanupProject(away.id);
  }
});

const IMAGE_REPO = "localhost/deploykit/edge-app";

async function makeRelease(
  deploymentId: string,
  projectId: string,
  digest: string,
  repository = IMAGE_REPO
) {
  return createRelease({
    deploymentId,
    projectId,
    imageRepository: repository,
    imageDigest: digest,
    commitSha: "a".repeat(40),
    branch: "main",
    supersedesReleaseId: null,
  });
}

test("edge agent claims its own targeted job with a fail-closed null image", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("edgeclaim"));
  try {
    const { agent } = await makeAgent(project.id, "owner");
    const deployment = await makeTargetedDeployment(project.id, agent.id);
    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    assert.equal(claimed.deploymentId, deployment.id);
    assert.equal(claimed.agentId, agent.id);

    assert.equal(claimed.image, null);
    const done = await completeAgentJob(agent.id, claimed.id, {
      outcome: "succeeded",
    });
    assert.equal(done.result, "completed");
  } finally {
    await cleanupProject(project.id);
  }
});

test("claim resolves the trusted image from the deployment's own release", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("ownrelease"));
  try {
    const { agent } = await makeAgent(project.id, "runner");
    const deployment = await makeTargetedDeployment(project.id, agent.id);
    const digest = `sha256:${"e".repeat(64)}`;
    const release = await makeRelease(deployment.id, project.id, digest);
    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    assert.deepEqual(claimed.image, {
      repository: IMAGE_REPO,
      digest,
      releaseId: release.id,
    });

    const done = await completeAgentJob(agent.id, claimed.id, {
      outcome: "succeeded",
      imageDigest: digest,
      commitSha: "a".repeat(40),
    });
    assert.equal(done.result, "completed");
  } finally {
    await cleanupProject(project.id);
  }
});

test("claim resolves the trusted image from the rollback target release", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("rollbackimg"));
  try {
    const { agent } = await makeAgent(project.id, "rollbacker");
    const source = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    assert.ok(source);
    const digest = `sha256:${"b".repeat(64)}`;
    const release = await makeRelease(source.id, project.id, digest);
    const deployment = await createDeployment({
      projectId: project.id,
      trigger: "rollback",
      idempotencyKey: null,
      rollbackReleaseId: release.id,
      targetAgentId: agent.id,
    });
    assert.ok(deployment);
    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    assert.equal(claimed.deploymentId, deployment.id);
    assert.deepEqual(claimed.image, {
      repository: IMAGE_REPO,
      digest,
      releaseId: release.id,
    });
  } finally {
    await cleanupProject(project.id);
  }
});

test("missing artifacts fail closed with a null image", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("noartifact"));
  try {
    const { agent } = await makeAgent(project.id, "empty");

    const bare = await makeTargetedDeployment(project.id, agent.id);
    const first = await claimAgentJob(agent.id);
    assert.ok(first);
    assert.equal(first.deploymentId, bare.id);
    assert.equal(first.image, null);
    await failAgentJob(agent.id, first.id, { errorMessage: "blocked: no image" });

    const source = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    assert.ok(source);
    const release = await makeRelease(source.id, project.id, `sha256:${"c".repeat(64)}`);
    const rollback = await createDeployment({
      projectId: project.id,
      trigger: "rollback",
      idempotencyKey: null,
      rollbackReleaseId: release.id,
      targetAgentId: agent.id,
    });
    assert.ok(rollback);
    await pool.query(`DELETE FROM releases WHERE id = $1`, [release.id]);
    const second = await claimAgentJob(agent.id);
    assert.ok(second);
    assert.equal(second.image, null);
  } finally {
    await cleanupProject(project.id);
  }
});

test("malformed digests and repositories fail closed and are never returned", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("malformed"));
  try {
    const { agent } = await makeAgent(project.id, "strict");

    const badDigest = await makeTargetedDeployment(project.id, agent.id);
    await pool.query(
      `UPDATE deployments SET image_repository = $2, image_digest = $3 WHERE id = $1`,
      [badDigest.id, IMAGE_REPO, "not-a-digest"]
    );
    const first = await claimAgentJob(agent.id);
    assert.ok(first);
    assert.equal(first.image, null);
    await failAgentJob(agent.id, first.id, { errorMessage: "blocked" });

    const localRepo = await makeTargetedDeployment(project.id, agent.id);
    await pool.query(
      `UPDATE deployments SET image_repository = $2, image_digest = $3 WHERE id = $1`,
      [localRepo.id, "deploykit/project-local", `sha256:${"d".repeat(64)}`]
    );
    const second = await claimAgentJob(agent.id);
    assert.ok(second);
    assert.equal(second.image, null);
    await failAgentJob(agent.id, second.id, { errorMessage: "blocked" });

    const dep = await makeTargetedDeployment(project.id, agent.id);
    const release = await makeRelease(dep.id, project.id, `sha256:${"e".repeat(64)}`);
    await pool.query(`UPDATE releases SET image_digest = 'garbage' WHERE id = $1`, [release.id]);
    const third = await claimAgentJob(agent.id);
    assert.ok(third);
    assert.equal(third.image, null);
  } finally {
    await cleanupProject(project.id);
  }
});

test("cross-project release artifacts never leak into another project's claim", async () => {
  if (!(await dbAvailable())) return;
  const home = await makeProject(uniqueName("xhome"));
  const away = await makeProject(uniqueName("xaway"));
  try {
    const { agent } = await makeAgent(home.id, "guarded");
    const foreignSource = await createDeployment({
      projectId: away.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    assert.ok(foreignSource);
    const foreignRelease = await makeRelease(foreignSource.id, away.id, `sha256:${"f".repeat(64)}`);
    const homeSource = await createDeployment({
      projectId: home.id,
      trigger: "manual",
      idempotencyKey: null,
    });
    assert.ok(homeSource);
    const homeRelease = await makeRelease(homeSource.id, home.id, `sha256:${"a".repeat(64)}`);
    const deployment = await createDeployment({
      projectId: home.id,
      trigger: "rollback",
      idempotencyKey: null,
      rollbackReleaseId: homeRelease.id,
      targetAgentId: agent.id,
    });
    assert.ok(deployment);

    await pool.query(`UPDATE deployments SET rollback_release_id = $2 WHERE id = $1`, [
      deployment.id,
      foreignRelease.id,
    ]);
    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    assert.equal(claimed.image, null);
  } finally {
    await cleanupProject(home.id);
    await cleanupProject(away.id);
  }
});

test("client-supplied digests are never adopted; mismatches are rejected", async () => {
  if (!(await dbAvailable())) return;
  const project = await makeProject(uniqueName("substitution"));
  try {
    const { agent } = await makeAgent(project.id, "honest");
    const deployment = await makeTargetedDeployment(project.id, agent.id);
    const trusted = `sha256:${"9".repeat(64)}`;
    await makeRelease(deployment.id, project.id, trusted);
    const claimed = await claimAgentJob(agent.id);
    assert.ok(claimed);
    assert.equal(claimed.image?.digest, trusted);

    const forged = `sha256:${"0".repeat(64)}`;
    await assert.rejects(
      completeAgentJob(agent.id, claimed.id, { outcome: "succeeded", imageDigest: forged }),
      (e: unknown) => e instanceof AgentJobError && e.code === "IMAGE_MISMATCH"
    );
    const row = (
      await pool.query(`SELECT image_digest FROM deployments WHERE id = $1`, [deployment.id])
    ).rows[0] as { image_digest: string | null };
    assert.equal(row.image_digest, null);
    const jobRow = (
      await pool.query(`SELECT status FROM deployment_jobs WHERE id = $1`, [claimed.id])
    ).rows[0] as { status: string };
    assert.equal(jobRow.status, "running");

    const done = await completeAgentJob(agent.id, claimed.id, {
      outcome: "succeeded",
      imageDigest: trusted,
    });
    assert.equal(done.result, "completed");

    const secondDep = await makeTargetedDeployment(project.id, agent.id);
    await makeRelease(secondDep.id, project.id, `sha256:${"8".repeat(64)}`);
    const second = await claimAgentJob(agent.id);
    assert.ok(second);
    const omitted = await completeAgentJob(agent.id, second.id, { outcome: "succeeded" });
    assert.equal(omitted.result, "completed");
  } finally {
    await cleanupProject(project.id);
  }
});
