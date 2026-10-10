import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pool from "../db/database.js";
import { RealDeploymentExecutor } from "./deploymentPipeline.js";
import { PipelineError } from "../deployments/deploymentErrors.js";

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
    writeFileSync(path.join(dir, name), content);
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
  if (!(await dbAvailable())) return;
  await expectPreflightFailure({}, "PREFLIGHT_MISSING_INPUTS");
});

test("Node.js repository without a Dockerfile requires configuration", async () => {
  if (!(await dbAvailable())) return;
  await expectPreflightFailure(
    { "package.json": '{"name":"app"}', "package-lock.json": "{}" },
    "PREFLIGHT_NEEDS_CONFIG"
  );
});

test("conflicting lockfiles fail preflight before building", async () => {
  if (!(await dbAvailable())) return;
  await expectPreflightFailure(
    { "package.json": "{}", "package-lock.json": "{}", "yarn.lock": "" },
    "PREFLIGHT_CONFLICTING_LOCKFILES"
  );
});

test("Dockerfile repository passes preflight and reaches the build", async () => {
  if (!(await dbAvailable())) return;
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
