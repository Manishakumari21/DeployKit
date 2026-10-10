import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import pool from "../db/database.js";
import { RealDeploymentExecutor } from "./deploymentPipeline.js";
import { getDeploymentById } from "../services/deploymentService.js";
import { getReleaseById } from "../services/releaseService.js";
import { getProjectGateway } from "../services/gatewayService.js";

const PREFLIGHT_WORKSPACE = mkdtempSync(path.join(os.tmpdir(), "deploykit-preflight-"));
writeFileSync(path.join(PREFLIGHT_WORKSPACE, "Dockerfile"), "FROM scratch\n");
after(() => {
  rmSync(PREFLIGHT_WORKSPACE, { recursive: true, force: true });
});

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

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"b".repeat(64)}`;

function fakeBuild() {
  return {
    async build(request: {
      imageRepository: string;
      imageTag: string;
      commitSha: string;
    }) {
      return {
        imageReference: `${request.imageRepository}:${request.imageTag}`,
        imageDigest: DIGEST,
      };
    },
  };
}

function fakeRuntime() {
  const containers = new Map<string, string>();
  return {
    containers,
    async create(spec: {
      containerName: string;
      imageReference: string;
      networkName: string;
      containerPort: number;
      healthPath: string;
    }) {
      if (!/@sha256:[0-9a-f]{64}$/i.test(spec.imageReference)) {
        throw new Error("digest required");
      }
      containers.set(spec.containerName, spec.imageReference);
      return {
        containerId: `id-${spec.containerName}`,
        containerName: spec.containerName,
        containerPort: spec.containerPort,
        ipAddress: "172.19.0.99",
        networkName: spec.networkName,
        healthPath: spec.healthPath,
      };
    },
    async start() {},
    async stop(name: string) {
      containers.delete(name);
    },
    async remove(name: string) {
      containers.delete(name);
    },
    async inspect(name: string) {
      return {
        containerId: `id-${name}`,
        containerName: name,
        containerPort: 3000,
        ipAddress: "172.19.0.99",
        networkName: "deploykit-runtime",
        healthPath: "/",
      };
    },
    async waitForHealthy() {},
    async pull() {},
  };
}

function fakeRouter() {
  const synced: Array<Record<string, unknown>> = [];
  let verified = 0;
  return {
    synced,
    get verified() {
      return verified;
    },
    async sync(target: Record<string, unknown>) {
      synced.push(target);
    },
    async verifyRoute() {
      verified++;
    },
    async remove() {},
    async activeTarget() {
      return null;
    },
  };
}

function fakeCheckout(SHAValue: string) {
  return (async (_opts: unknown, work: unknown) => {
    const fn = work as (c: {
      workspace: string;
      commitSha: string;
    }) => Promise<never>;
    return fn({ workspace: PREFLIGHT_WORKSPACE, commitSha: SHAValue });
  }) as never;
}

async function createProject(name: string) {
  const result = await pool.query(
    `
    INSERT INTO projects (name, repository_url, branch)
    VALUES ($1, 'https://github.com/acme/app.git', 'main')
    RETURNING *
    `,
    [name]
  );
  return result.rows[0];
}

async function createDeploymentRow(projectId: string) {
  const result = await pool.query(
    `
    INSERT INTO deployments (project_id, status, trigger, branch)
    VALUES ($1, 'cloning', 'manual', 'main')
    RETURNING *
    `,
    [projectId]
  );
  await pool.query(
    `
    INSERT INTO deployment_jobs (deployment_id, status, attempts, max_attempts)
    VALUES ($1, 'running', 1, 3)
    `,
    [result.rows[0].id]
  );
  return result.rows[0];
}

function executorWith(
  runtime: ReturnType<typeof fakeRuntime>,
  router: ReturnType<typeof fakeRouter>,

  extra: Record<string, any> = {}
) {
  return new RealDeploymentExecutor({

    buildExecutor: fakeBuild() as any,

    runtimeManager: runtime as any,

    trafficRouter: router as any,
    checkout: fakeCheckout(SHA),
    runtimeNetwork: "deploykit-runtime",
    healthTimeoutMs: 1000,
    routeTimeoutMs: 1000,
    gatewayName: "dk-gateway",
    ...extra,
  });
}

test("unhealthy release never switches traffic and old release stays active", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`zdt-keep-${Date.now()}`);
  try {
    const first = await createDeploymentRow(project.id);
    const runtime = fakeRuntime();
    const router = fakeRouter();
    const executor = executorWith(runtime, router);
    await executor.execute({
      deploymentId: first.id,
      jobId: "job-1",
      attempt: 1,
      maxAttempts: 3,
    });
    const activeBefore = (
      await pool.query(
        `SELECT id FROM releases WHERE project_id = $1 AND status = 'active'`,
        [project.id]
      )
    ).rows[0].id;
    assert.equal(router.synced.length, 1);

    const second = await createDeploymentRow(project.id);
    const failing = fakeRuntime();

    (failing as any).waitForHealthy = async () => {
      throw new Error("readiness probe failed");
    };
    const executor2 = executorWith(failing, router);
    await assert.rejects(
      executor2.execute({
        deploymentId: second.id,
        jobId: "job-2",
        attempt: 1,
        maxAttempts: 3,
      }),
      /readiness probe failed/
    );
    assert.equal(router.synced.length, 1);
    const activeAfter = (
      await pool.query(
        `SELECT id FROM releases WHERE project_id = $1 AND status = 'active'`,
        [project.id]
      )
    ).rows[0].id;
    assert.equal(activeAfter, activeBefore);
    const gateway = await getProjectGateway(project.id);
    assert.equal(gateway.active_release_id, activeBefore);
    const failedDep = await getDeploymentById(second.id);
    assert.equal(failedDep.status, "verifying");
    assert.equal(failing.containers.size, 0);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("traffic switches only after the new release is healthy", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`zdt-order-${Date.now()}`);
  try {
    const deployment = await createDeploymentRow(project.id);
    const runtime = fakeRuntime();
    const order: string[] = [];
    const router = fakeRouter();
    const origSync = router.sync.bind(router);
    router.sync = async (target: Record<string, unknown>) => {
      const rel = await getReleaseById(target.releaseId as string);
      order.push(`sync:${rel.status}`);
      return origSync(target);
    };
    const executor = executorWith(runtime, router);
    await executor.execute({
      deploymentId: deployment.id,
      jobId: "job-1",
      attempt: 1,
      maxAttempts: 3,
    });
    assert.deepEqual(order, ["sync:active"]);
    const syncedRelease = await getReleaseById(router.synced[0].releaseId as string);
    assert.ok(syncedRelease.healthy_at);
    assert.equal(router.verified, 1);
    const gateway = await getProjectGateway(project.id);
    const release = await getReleaseById(gateway.active_release_id);
    assert.equal(release.status, "active");
    assert.equal(gateway.target_container, router.synced[0].containerName);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("worker restart resumes a stuck deployment without rebuilding", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`zdt-resume-${Date.now()}`);
  try {
    const deployment = await createDeploymentRow(project.id);
    const runtime = fakeRuntime();
    const router = fakeRouter();
    let builds = 0;
    const countingBuild = {
      async build(request: {
        imageRepository: string;
        imageTag: string;
        commitSha: string;
      }) {
        builds++;
        return {
          imageReference: `${request.imageRepository}:${request.imageTag}`,
          imageDigest: DIGEST,
        };
      },
    };
    const first = new RealDeploymentExecutor({

      buildExecutor: countingBuild as any,

      runtimeManager: runtime as any,

      trafficRouter: {
        ...router,
        async sync() {
          throw new Error("gateway down during first attempt");
        },
      } as any,
      checkout: fakeCheckout(SHA),
      runtimeNetwork: "deploykit-runtime",
      healthTimeoutMs: 1000,
      routeTimeoutMs: 1000,
      gatewayName: "dk-gateway",
    });
    await assert.rejects(
      first.execute({
        deploymentId: deployment.id,
        jobId: "job-1",
        attempt: 1,
        maxAttempts: 3,
      }),
      /gateway down/
    );
    assert.equal(builds, 1);
    const stuck = await getDeploymentById(deployment.id);
    assert.equal(stuck.status, "deploying");

    const failBuild = {
      async build() {
        throw new Error("must not rebuild on resume");
      },
    };
    const resumed = new RealDeploymentExecutor({

      buildExecutor: failBuild as any,

      runtimeManager: runtime as any,

      trafficRouter: router as any,
      checkout: (async () => {
        throw new Error("must not checkout on resume");
      }) as never,
      runtimeNetwork: "deploykit-runtime",
      healthTimeoutMs: 1000,
      routeTimeoutMs: 1000,
      gatewayName: "dk-gateway",
    });
    const result = await resumed.execute({
      deploymentId: deployment.id,
      jobId: "job-1",
      attempt: 2,
      maxAttempts: 3,
    });
    assert.equal(result.imageDigest, DIGEST);
    assert.equal(router.synced.length, 1);
    const done = await getDeploymentById(deployment.id);
    assert.equal(done.status, "deploying");
    const release = await getReleaseById(done.release_id);
    assert.equal(release.status, "active");
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("cleanup of superseded runtimes is idempotent", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`zdt-clean-${Date.now()}`);
  try {
    const runtime = fakeRuntime();
    const router = fakeRouter();
    const executor = executorWith(runtime, router);
    const first = await createDeploymentRow(project.id);
    await executor.execute({
      deploymentId: first.id,
      jobId: "job-1",
      attempt: 1,
      maxAttempts: 3,
    });
    const second = await createDeploymentRow(project.id);
    await executor.execute({
      deploymentId: second.id,
      jobId: "job-2",
      attempt: 1,
      maxAttempts: 3,
    });
    assert.equal(runtime.containers.size, 1);
    const rows = await pool.query(
      `SELECT status FROM runtime_instances WHERE status IN ('running','starting')`
    );
    const mine = await pool.query(
      `SELECT i.status FROM runtime_instances i
       JOIN releases r ON r.id = i.release_id
       WHERE r.project_id = $1 AND i.status IN ('running','starting')`,
      [project.id]
    );
    assert.equal(mine.rowCount, 1);
    assert.ok((rows.rowCount ?? 0) >= 1);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});
