import test from "node:test";
import assert from "node:assert/strict";
import pool from "../db/database.js";
import { RealDeploymentExecutor } from "./deploymentPipeline.js";
import { claimNextJob, recoverExpiredJobs } from "./deploymentQueue.js";
import { BuildExecutorError } from "../infrastructure/build/buildxBuildExecutor.js";
import { PIPELINE_ERROR_CODES } from "../deployments/deploymentErrors.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"c".repeat(64)}`;

function fakeBuild() {
  return {
    async build(request: { imageRepository: string; imageTag: string; commitSha: string }) {
      return { imageReference: `${request.imageRepository}:${request.imageTag}`, imageDigest: DIGEST };
    },
  };
}

function fakeRuntime() {
  const containers = new Map<string, string>();
  return {
    containers,
    async create(spec: { containerName: string; imageReference: string; networkName: string; containerPort: number; healthPath: string }) {
      containers.set(spec.containerName, spec.imageReference);
      return { containerId: "a".repeat(64), containerName: spec.containerName, containerPort: spec.containerPort, ipAddress: "172.19.0.9", networkName: spec.networkName, healthPath: spec.healthPath };
    },
    async start() {},
    async stop(name: string) { containers.delete(name); },
    async remove(name: string) { containers.delete(name); },
    async inspect(name: string) {
      return { containerId: "a".repeat(64), containerName: name, containerPort: 3000, ipAddress: "172.19.0.9", networkName: "deploykit-runtime", healthPath: "/" };
    },
    async waitForHealthy() {},
    async pull() {},
  };
}

function fakeRouter() {
  return { async sync() {}, async verifyRoute() {}, async remove() {}, async activeTarget() { return null; } };
}

function fakeCheckout(sha: string) {
  return (async (_opts: unknown, work: unknown) => {
    const fn = work as (c: { workspace: string; commitSha: string }) => Promise<unknown>;
    return fn({ workspace: "/tmp", commitSha: sha });
  }) as never;
}

async function createProject(name: string) {
  const r = await pool.query(
    `INSERT INTO projects (name, repository_url, branch) VALUES ($1, 'https://github.com/acme/app.git', 'main') RETURNING *`,
    [name]
  );
  return r.rows[0];
}

async function createQueuedDeployment(projectId: string, sha: string | null = null) {
  const r = await pool.query(
    `INSERT INTO deployments (project_id, status, trigger, branch, commit_sha) VALUES ($1, 'queued', 'manual', 'main', $2) RETURNING *`,
    [projectId, sha]
  );
  await pool.query(`INSERT INTO deployment_jobs (deployment_id, status, attempts, max_attempts) VALUES ($1, 'queued', 0, 3)`, [r.rows[0].id]);
  return r.rows[0];
}

function executorWith(runtime: ReturnType<typeof fakeRuntime>) {
  return new RealDeploymentExecutor({
    buildExecutor: fakeBuild() as never,
    runtimeManager: runtime as never,
    trafficRouter: fakeRouter() as never,
    checkout: fakeCheckout(SHA),
    runtimeNetwork: "deploykit-runtime",
    healthTimeoutMs: 1000,
    routeTimeoutMs: 1000,
    gatewayName: "dk-gateway",
  });
}

test("crash during build recovers via lease and resumes to active exactly once", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`crash-build-${Date.now()}`);
  try {
    const dep = await createQueuedDeployment(project.id);
    // Worker 1 claims then crashes (never completes); force lease expiry.
    const claimed = await claimNextJob("worker-crash-1", 50);
    assert.ok(claimed);
    await pool.query(`UPDATE deployment_jobs SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1`, [claimed!.id]);
    const recovered = await recoverExpiredJobs();
    assert.ok(recovered >= 1);
    // Worker 2 restarts after bootstrap and resumes the same deployment.
    const claimed2 = await claimNextJob("worker-restart-2", 30_000);
    assert.ok(claimed2);
    assert.equal(claimed2!.deploymentId, dep.id);
    const runtime = fakeRuntime();
    await executorWith(runtime).execute({ deploymentId: dep.id, jobId: claimed2!.id, attempt: claimed2!.attempts, maxAttempts: 3 });
    await pool.query(`UPDATE deployment_jobs SET status='succeeded' WHERE id=$1`, [claimed2!.id]);
    const active = await pool.query(`SELECT COUNT(*)::int AS c FROM releases WHERE project_id=$1 AND status='active'`, [project.id]);
    assert.equal(active.rows[0].c, 1);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id=$1`, [project.id]);
  }
});

test("duplicate execution never creates conflicting active releases", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`crash-dup-${Date.now()}`);
  try {
    const d1 = await createQueuedDeployment(project.id);
    const d2 = await createQueuedDeployment(project.id);
    const c1 = await claimNextJob("w-dup-1", 30_000);
    const c2 = await claimNextJob("w-dup-2", 30_000);
    assert.ok(c1 && c2);
    const r1 = fakeRuntime();
    const r2 = fakeRuntime();
    await Promise.all([
      executorWith(r1).execute({ deploymentId: c1!.deploymentId, jobId: c1!.id, attempt: 1, maxAttempts: 3 }),
      executorWith(r2).execute({ deploymentId: c2!.deploymentId, jobId: c2!.id, attempt: 1, maxAttempts: 3 }),
    ]);
    const active = await pool.query(`SELECT COUNT(*)::int AS c FROM releases WHERE project_id=$1 AND status='active'`, [project.id]);
    assert.equal(active.rows[0].c, 1);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id=$1`, [project.id]);
  }
});

test("cancelled deployment refuses execution with typed DEPLOYMENT_CANCELLED", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`crash-cancel-${Date.now()}`);
  try {
    const dep = await createQueuedDeployment(project.id);
    await pool.query(`UPDATE deployments SET status='cancelled', finished_at=CURRENT_TIMESTAMP WHERE id=$1`, [dep.id]);
    await pool.query(`UPDATE deployment_jobs SET status='cancelled' WHERE deployment_id=$1`, [dep.id]);
    const runtime = fakeRuntime();
    await assert.rejects(
      () => executorWith(runtime).execute({ deploymentId: dep.id, jobId: "job-x", attempt: 1, maxAttempts: 3 }),
      (e: unknown) => {
        assert.equal((e as { code: string }).code, PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED);
        return true;
      }
    );
    const active = await pool.query(`SELECT COUNT(*)::int AS c FROM releases WHERE project_id=$1 AND status='active'`, [project.id]);
    assert.equal(active.rows[0].c, 0);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id=$1`, [project.id]);
  }
});

test("aborted build signal maps to typed DEPLOYMENT_CANCELLED", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`crash-abort-${Date.now()}`);
  try {
    const dep = await createQueuedDeployment(project.id, SHA);
    await pool.query(`UPDATE deployments SET status='cloning' WHERE id=$1`, [dep.id]);
    const abortingBuild = {
      async build(_r: unknown, signal?: AbortSignal) {
        void _r;
        void signal;
        throw new BuildExecutorError("BUILD_CANCELLED", "Docker build was cancelled");
      },
    };
    const executor = new RealDeploymentExecutor({
      buildExecutor: abortingBuild as never,
      runtimeManager: fakeRuntime() as never,
      trafficRouter: fakeRouter() as never,
      checkout: fakeCheckout(SHA),
      runtimeNetwork: "deploykit-runtime",
      healthTimeoutMs: 1000,
      routeTimeoutMs: 1000,
      gatewayName: "dk-gateway",
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => executor.execute({ deploymentId: dep.id, jobId: "job-abort", attempt: 1, maxAttempts: 3, signal: controller.signal }),
      (e: unknown) => {
        assert.equal((e as { code: string }).code, PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED);
        return true;
      }
    );
  } finally {
    await pool.query(`DELETE FROM projects WHERE id=$1`, [project.id]);
  }
});
