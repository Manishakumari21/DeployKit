import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import pool from "../db/database.js";
import { RealDeploymentExecutor } from "./deploymentPipeline.js";
import { getDeploymentById } from "../services/deploymentService.js";
import { getReleaseById } from "../services/releaseService.js";

const PREFLIGHT_WORKSPACE = mkdtempSync(path.join(os.tmpdir(), "deploykit-preflight-"));
writeFileSync(path.join(PREFLIGHT_WORKSPACE, "Dockerfile"), "FROM scratch\n");
after(() => {
  rmSync(PREFLIGHT_WORKSPACE, { recursive: true, force: true });
});

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
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
  return {
    async sync() {},
    async verifyRoute() {},
    async remove() {},
    async activeTarget() {
      return null;
    },
  };
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

test("pipeline builds, releases and leaves deployment deploying", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`pipe-${Date.now()}`);
  try {
    const deployment = await createDeploymentRow(project.id);
    const runtime = fakeRuntime();
    const executor = new RealDeploymentExecutor({

      buildExecutor: fakeBuild() as any,

      runtimeManager: runtime as any,
      checkout: (async (_opts: unknown, work: unknown) => {
        const fn = work as (c: {
          workspace: string;
          commitSha: string;
        }) => Promise<never>;
        return fn({ workspace: PREFLIGHT_WORKSPACE, commitSha: SHA });
      }) as never,
      runtimeNetwork: "deploykit-runtime",
      gatewayName: "dk-gateway",
      routeTimeoutMs: 1000,

      trafficRouter: fakeRouter() as any,
      healthTimeoutMs: 1000,
    });
    const result = await executor.execute({
      deploymentId: deployment.id,
      jobId: "job-1",
      attempt: 1,
      maxAttempts: 3,
    });
    assert.equal(result.commitSha, SHA);
    assert.equal(result.imageDigest, DIGEST);
    const updated = await getDeploymentById(deployment.id);
    assert.equal(updated.status, "deploying");
    assert.equal(updated.commit_sha, SHA);
    assert.equal(updated.image_digest, DIGEST);
    assert.ok(updated.release_id);
    const release = await getReleaseById(updated.release_id);
    assert.equal(release.status, "active");
    assert.equal(release.image_digest, DIGEST);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("rollback reuses the stored digest without rebuilding", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`piperb-${Date.now()}`);
  try {
    const seedDep = await pool.query(
      `INSERT INTO deployments (project_id, status, trigger, branch, commit_sha, image_repository, image_digest)
       VALUES ($1,'active','manual','main',$2,'deploykit/seed','sha256:${"c".repeat(64)}') RETURNING *`,
      [project.id, SHA]
    );
    const seedRel = await pool.query(
      `INSERT INTO releases (deployment_id, project_id, image_repository, image_digest, commit_sha, branch, status)
       VALUES ($1,$2,'deploykit/seed','sha256:${"c".repeat(64)}',$3,'main','active') RETURNING *`,
      [seedDep.rows[0].id, project.id, SHA]
    );
    const rbDep = await pool.query(
      `INSERT INTO deployments (project_id, status, trigger, branch, rollback_release_id)
       VALUES ($1,'cloning','rollback','main',$2) RETURNING *`,
      [project.id, seedRel.rows[0].id]
    );
    await pool.query(
      `INSERT INTO deployment_jobs (deployment_id, status, attempts, max_attempts)
       VALUES ($1,'running',1,3)`,
      [rbDep.rows[0].id]
    );

    let buildCalls = 0;
    const countingBuild = {
      async build() {
        buildCalls++;
        throw new Error("must not rebuild on rollback");
      },
    };
    const runtime = fakeRuntime();
    const executor = new RealDeploymentExecutor({

      buildExecutor: countingBuild as any,

      runtimeManager: runtime as any,
      checkout: (async () => {
        throw new Error("must not checkout on rollback");
      }) as never,
      runtimeNetwork: "deploykit-runtime",
      gatewayName: "dk-gateway",
      routeTimeoutMs: 1000,

      trafficRouter: fakeRouter() as any,
      healthTimeoutMs: 1000,
    });
    const result = await executor.execute({
      deploymentId: rbDep.rows[0].id,
      jobId: "job-rb",
      attempt: 1,
      maxAttempts: 3,
    });
    assert.equal(buildCalls, 0);
    assert.equal(result.imageDigest, `sha256:${"c".repeat(64)}`);
    const updated = await getDeploymentById(rbDep.rows[0].id);
    assert.equal(updated.status, "deploying");
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("pipeline cleans up new runtime when health fails", async () => {
  if (!(await dbAvailable())) {
    return;
  }
  const project = await createProject(`pipefail-${Date.now()}`);
  try {
    const deployment = await createDeploymentRow(project.id);
    const runtime = fakeRuntime();

    (runtime as any).waitForHealthy = async () => {
      throw new Error("unhealthy");
    };
    const executor = new RealDeploymentExecutor({

      buildExecutor: fakeBuild() as any,

      runtimeManager: runtime as any,
      checkout: (async (_opts: unknown, work: unknown) => {
        const fn = work as (c: {
          workspace: string;
          commitSha: string;
        }) => Promise<never>;
        return fn({ workspace: PREFLIGHT_WORKSPACE, commitSha: SHA });
      }) as never,
      runtimeNetwork: "deploykit-runtime",
      gatewayName: "dk-gateway",
      routeTimeoutMs: 1000,

      trafficRouter: fakeRouter() as any,
      healthTimeoutMs: 1000,
    });
    await assert.rejects(
      executor.execute({
        deploymentId: deployment.id,
        jobId: "job-1",
        attempt: 1,
        maxAttempts: 3,
      }),
      /unhealthy/
    );
    assert.equal(runtime.containers.size, 0);
  } finally {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});
