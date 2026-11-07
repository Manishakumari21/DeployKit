import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pool from "../db/database.js";
import { RealDeploymentExecutor } from "./deploymentPipeline.js";
import { PipelineError } from "../deployments/deploymentErrors.js";
import { gateDb } from "../test/dbGate.js";
import { saveProjectBuildConfig } from "../services/buildConfigService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"d".repeat(64)}`;

function makeWorkspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploykit-preflight-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function stubCheckout(workspace: string) {
  return (async (_opts: unknown, work: unknown) => {
    const fn = work as (c: { workspace: string; commitSha: string }) => Promise<never>;
    return fn({ workspace, commitSha: SHA });
  }) as never;
}

function countingBuild(counter: { calls: number }) {
  return {
    async build() {
      counter.calls += 1;
      return { imageReference: `deploykit/x:d`, imageDigest: DIGEST };
    },
  };
}

async function createProject(name: string) {
  const result = await pool.query(
    `INSERT INTO projects (name, repository_url, branch) VALUES ($1, 'https://github.com/acme/app.git', 'main') RETURNING *`,
    [name]
  );
  return result.rows[0];
}

async function createDeploymentRow(projectId: string) {
  const result = await pool.query(
    `INSERT INTO deployments (project_id, status, trigger, branch) VALUES ($1, 'cloning', 'manual', 'main') RETURNING *`,
    [projectId]
  );
  await pool.query(
    `INSERT INTO deployment_jobs (deployment_id, status, attempts, max_attempts) VALUES ($1, 'running', 1, 3)`,
    [result.rows[0].id]
  );
  return result.rows[0];
}

async function preflightEvents(deploymentId: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT event_type FROM deployment_events WHERE deployment_id = $1 AND event_type LIKE 'deployment.preflight%' ORDER BY created_at ASC`,
    [deploymentId]
  );
  return result.rows.map((row: { event_type: string }) => row.event_type);
}

async function expectPreflightFailure(
  files: Record<string, string>,
  expectedCode: string
): Promise<void> {
  const workspace = makeWorkspace(files);
  const project = await createProject(`preflight-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  try {
    const deployment = await createDeploymentRow(project.id);
    const counter = { calls: 0 };
    const executor = new RealDeploymentExecutor({
      buildExecutor: countingBuild(counter) as never,
      checkout: stubCheckout(workspace),
    });
    await assert.rejects(
      executor.execute({
        deploymentId: deployment.id,
        jobId: "job-preflight",
        attempt: 1,
        maxAttempts: 3,
      }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineError);
        assert.equal(error.code, expectedCode);
        assert.equal(error.retryable, false);
        return true;
      }
    );
    assert.equal(counter.calls, 0, "build must never run after a failed preflight");
    assert.deepEqual(await preflightEvents(deployment.id), ["deployment.preflight_failed"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
}

test("empty repository fails preflight before building", async () => {
  if (!(await gateDb("workers/deploymentPreflight.db.unit.test.ts", dbAvailable))) return;
  await expectPreflightFailure({}, "PREFLIGHT_MISSING_INPUTS");
});

test("Node.js repository without a Dockerfile requires configuration", async () => {
  if (!(await gateDb("workers/deploymentPreflight.db.unit.test.ts", dbAvailable))) return;
  await expectPreflightFailure(
    { "package.json": '{"name":"app"}', "package-lock.json": "{}" },
    "PREFLIGHT_NEEDS_CONFIG"
  );
});

test("conflicting lockfiles fail preflight before building", async () => {
  if (!(await gateDb("workers/deploymentPreflight.db.unit.test.ts", dbAvailable))) return;
  await expectPreflightFailure(
    { "package.json": "{}", "package-lock.json": "{}", "yarn.lock": "" },
    "PREFLIGHT_CONFLICTING_LOCKFILES"
  );
});

test("Dockerfile repository passes preflight and reaches the build", async () => {
  if (!(await gateDb("workers/deploymentPreflight.db.unit.test.ts", dbAvailable))) return;
  const workspace = makeWorkspace({ Dockerfile: "FROM scratch\n" });
  const project = await createProject(`preflight-ok-${Date.now()}`);
  try {
    const deployment = await createDeploymentRow(project.id);
    const counter = { calls: 0 };
    const executor = new RealDeploymentExecutor({
      buildExecutor: countingBuild(counter) as never,
      checkout: stubCheckout(workspace),
      runtimeManager: {
        async pull() {},
        async create(spec: { containerName: string }) {
          return {
            containerId: `id-${spec.containerName}`,
            containerName: spec.containerName,
            containerPort: 3000,
            ipAddress: "172.19.0.99",
            networkName: "deploykit-runtime",
            healthPath: "/",
          };
        },
        async start() {},
        async stop() {},
        async remove() {},
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
        async waitForHealthy() {
          throw new Error("stop after build");
        },
      } as never,
    });
    await assert.rejects(
      executor.execute({
        deploymentId: deployment.id,
        jobId: "job-preflight-ok",
        attempt: 1,
        maxAttempts: 3,
      }),
      /stop after build/
    );
    assert.equal(counter.calls, 1, "valid Dockerfile repositories must still build");
    assert.deepEqual(await preflightEvents(deployment.id), ["deployment.preflight_passed"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("Go repository without a Dockerfile automatically generates a Dockerfile and reaches the build", async () => {
  if (!(await gateDb("workers/deploymentPreflight.db.unit.test.ts", dbAvailable))) return;
  const workspace = makeWorkspace({
    "go.mod": "module github.com/example/server\n\ngo 1.22\n",
    "main.go": "package main\nfunc main() {}\n",
  });
  const project = await createProject(`preflight-go-${Date.now()}`);
  try {
    const deployment = await createDeploymentRow(project.id);
    let capturedDockerfilePath: string | null | undefined = null;
    const customBuild = {
      async build(req: { dockerfilePath?: string | null }) {
        capturedDockerfilePath = req.dockerfilePath;
        return {
          imageReference: "test-repo:test-tag",
          imageDigest: "sha256:" + "0".repeat(64),
        };
      },
    };
    const executor = new RealDeploymentExecutor({
      buildExecutor: customBuild as never,
      checkout: stubCheckout(workspace),
      runtimeManager: {
        async pull() {},
        async create(spec: { containerName: string }) {
          return {
            containerId: `id-${spec.containerName}`,
            containerName: spec.containerName,
            containerPort: 8080,
            ipAddress: "172.19.0.99",
            networkName: "deploykit-runtime",
            healthPath: "/",
          };
        },
        async start() {},
        async stop() {},
        async remove() {},
        async inspect(name: string) {
          return {
            containerId: `id-${name}`,
            containerName: name,
            containerPort: 8080,
            ipAddress: "172.19.0.99",
            networkName: "deploykit-runtime",
            healthPath: "/",
          };
        },
        async waitForHealthy() {
          throw new Error("stop after build");
        },
      } as never,
    });
    await assert.rejects(
      executor.execute({
        deploymentId: deployment.id,
        jobId: "job-preflight-go",
        attempt: 1,
        maxAttempts: 3,
      }),
      /stop after build/
    );
    assert.ok(capturedDockerfilePath, "generated Dockerfile path must be passed to build executor");
    assert.ok((capturedDockerfilePath as string).endsWith(".deploykit.generated.Dockerfile"));
    assert.deepEqual(await preflightEvents(deployment.id), ["deployment.preflight_passed"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("monorepo without applicationRoot triggers candidate suggestions and fails preflight", async () => {
  if (!(await gateDb("workers/deploymentPreflight.db.unit.test.ts", dbAvailable))) return;
  const workspace = makeWorkspace({
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
    "apps/api/package.json": '{"name":"api"}',
    "apps/web/package.json": '{"name":"web"}',
  });
  const project = await createProject(`preflight-monorepo-none-${Date.now()}`);
  try {
    const deployment = await createDeploymentRow(project.id);
    const counter = { calls: 0 };
    const executor = new RealDeploymentExecutor({
      buildExecutor: countingBuild(counter) as never,
      checkout: stubCheckout(workspace),
    });
    await assert.rejects(
      executor.execute({
        deploymentId: deployment.id,
        jobId: "job-preflight-monorepo",
        attempt: 1,
        maxAttempts: 3,
      }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineError);
        assert.equal(error.code, "PREFLIGHT_NEEDS_CONFIG");
        assert.ok(error.message.includes("Monorepo or multi-service layout detected"));
        return true;
      }
    );
    assert.equal(counter.calls, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("monorepo with valid applicationRoot pointing to apps/web resolves build context to apps/web with custom Dockerfile", async () => {
  if (!(await gateDb("workers/deploymentPreflight.db.unit.test.ts", dbAvailable))) return;
  const workspace = makeWorkspace({
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
    "apps/web/Dockerfile": "FROM scratch\n",
    "apps/api/go.mod": "module github.com/example/api\n\ngo 1.22\n",
    "apps/api/main.go": "package main\nfunc main() {}\n",
  });
  const project = await createProject(`preflight-web-root-${Date.now()}`);
  try {
    await saveProjectBuildConfig(project.id, {
      applicationRoot: "apps/web",
      builder: "dockerfile",
      dockerfilePath: "Dockerfile",
    });
    const deployment = await createDeploymentRow(project.id);
    let capturedWorkspace: string | null = null;
    let capturedDockerfilePath: string | null | undefined = null;
    const customBuild = {
      async build(req: { workspace: string; dockerfilePath?: string | null }) {
        capturedWorkspace = req.workspace;
        capturedDockerfilePath = req.dockerfilePath;
        return {
          imageReference: "test-repo:test-tag",
          imageDigest: "sha256:" + "0".repeat(64),
        };
      },
    };
    const executor = new RealDeploymentExecutor({
      buildExecutor: customBuild as never,
      checkout: stubCheckout(workspace),
      runtimeManager: {
        async pull() {},
        async create(spec: { containerName: string }) {
          return {
            containerId: `id-${spec.containerName}`,
            containerName: spec.containerName,
            containerPort: 3000,
            ipAddress: "172.19.0.99",
            networkName: "deploykit-runtime",
            healthPath: "/",
          };
        },
        async start() {},
        async stop() {},
        async remove() {},
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
        async waitForHealthy() {
          throw new Error("stop after build");
        },
      } as never,
    });
    await assert.rejects(
      executor.execute({
        deploymentId: deployment.id,
        jobId: "job-preflight-web-root",
        attempt: 1,
        maxAttempts: 3,
      }),
      /stop after build/
    );
    assert.equal(capturedWorkspace, path.join(workspace, "apps/web"));
    assert.equal(capturedDockerfilePath, path.join(workspace, "apps/web/Dockerfile"));
    assert.deepEqual(await preflightEvents(deployment.id), ["deployment.preflight_passed"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("monorepo with valid applicationRoot pointing to apps/api generates Dockerfile inside apps/api and passes effective workspace", async () => {
  if (!(await gateDb("workers/deploymentPreflight.db.unit.test.ts", dbAvailable))) return;
  const workspace = makeWorkspace({
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
    "apps/api/go.mod": "module github.com/example/api\n\ngo 1.22\n",
    "apps/api/main.go": "package main\nfunc main() {}\n",
  });
  const project = await createProject(`preflight-api-root-${Date.now()}`);
  try {
    await saveProjectBuildConfig(project.id, {
      applicationRoot: "apps/api",
      builder: "go",
    });
    const deployment = await createDeploymentRow(project.id);
    let capturedWorkspace: string | null = null;
    let capturedDockerfilePath: string | null | undefined = null;
    const customBuild = {
      async build(req: { workspace: string; dockerfilePath?: string | null }) {
        capturedWorkspace = req.workspace;
        capturedDockerfilePath = req.dockerfilePath;
        return {
          imageReference: "test-repo:test-tag",
          imageDigest: "sha256:" + "0".repeat(64),
        };
      },
    };
    const executor = new RealDeploymentExecutor({
      buildExecutor: customBuild as never,
      checkout: stubCheckout(workspace),
      runtimeManager: {
        async pull() {},
        async create(spec: { containerName: string }) {
          return {
            containerId: `id-${spec.containerName}`,
            containerName: spec.containerName,
            containerPort: 8080,
            ipAddress: "172.19.0.99",
            networkName: "deploykit-runtime",
            healthPath: "/",
          };
        },
        async start() {},
        async stop() {},
        async remove() {},
        async inspect(name: string) {
          return {
            containerId: `id-${name}`,
            containerName: name,
            containerPort: 8080,
            ipAddress: "172.19.0.99",
            networkName: "deploykit-runtime",
            healthPath: "/",
          };
        },
        async waitForHealthy() {
          throw new Error("stop after build");
        },
      } as never,
    });
    await assert.rejects(
      executor.execute({
        deploymentId: deployment.id,
        jobId: "job-preflight-api-root",
        attempt: 1,
        maxAttempts: 3,
      }),
      /stop after build/
    );
    assert.equal(capturedWorkspace, path.join(workspace, "apps/api"));
    assert.equal(
      capturedDockerfilePath,
      path.join(workspace, "apps/api/.deploykit.generated.Dockerfile")
    );
    assert.deepEqual(await preflightEvents(deployment.id), ["deployment.preflight_passed"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});

test("invalid applicationRoot with path traversal fails preflight before building", async () => {
  if (!(await gateDb("workers/deploymentPreflight.db.unit.test.ts", dbAvailable))) return;
  const workspace = makeWorkspace({
    "go.mod": "module github.com/example/api\n\ngo 1.22\n",
    "main.go": "package main\nfunc main() {}\n",
  });
  const project = await createProject(`preflight-traversal-${Date.now()}`);
  try {
    await pool.query(
      `UPDATE projects SET build_config = $2::jsonb WHERE id = $1`,
      [
        project.id,
        JSON.stringify({
          applicationRoot: "../outside",
          builder: "go",
          dockerfilePath: null,
          buildCommand: null,
          startCommand: null,
          outputDirectory: null,
        }),
      ]
    );
    const deployment = await createDeploymentRow(project.id);
    const counter = { calls: 0 };
    const executor = new RealDeploymentExecutor({
      buildExecutor: countingBuild(counter) as never,
      checkout: stubCheckout(workspace),
    });
    await assert.rejects(
      executor.execute({
        deploymentId: deployment.id,
        jobId: "job-preflight-traversal",
        attempt: 1,
        maxAttempts: 3,
      }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineError);
        assert.ok(error.code === "INVALID_CONFIG" || error.code === "PATH_ESCAPE");
        return true;
      }
    );
    assert.equal(counter.calls, 0);
    assert.deepEqual(await preflightEvents(deployment.id), ["deployment.preflight_failed"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
});
