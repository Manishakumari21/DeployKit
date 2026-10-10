import test from "node:test";
import assert from "node:assert/strict";
import pool from "../db/database.js";
import {
  cancelDeployment,
  createDeployment,
  DeploymentConflictError,
} from "./deploymentService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    const check = await pool.query(
      `SELECT to_regclass('public.deployments') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

async function createProject(name: string) {
  const result = await pool.query(
    `INSERT INTO projects (name, repository_url, branch) VALUES ($1, 'https://github.com/acme/app.git', 'main') RETURNING *`,
    [name]
  );
  return result.rows[0];
}

async function cleanup(projectIds: string[]): Promise<void> {
  for (const id of projectIds) {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [id]);
  }
  await pool.query(`DELETE FROM projects WHERE name LIKE 'cc-%'`);
}

async function nonTerminalCount(projectId: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM deployments
     WHERE project_id = $1
       AND status IN ('queued','cloning','building','pushing','verifying','deploying')`,
    [projectId]
  );
  return result.rows[0].n;
}

test("second non-terminal deployment for the same project is rejected", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`cc-second-${Date.now()}`);
  try {
    const first = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: `cc-k1-${Date.now()}`,
    });
    assert.ok(first?.id);
    await assert.rejects(
      createDeployment({
        projectId: project.id,
        trigger: "manual",
        idempotencyKey: `cc-k2-${Date.now()}`,
      }),
      (error: unknown) => {
        assert.ok(error instanceof DeploymentConflictError);
        assert.equal(
          (error as DeploymentConflictError).activeDeploymentId,
          first.id
        );
        assert.equal((error as DeploymentConflictError).status, 409);
        return true;
      }
    );
    assert.equal(await nonTerminalCount(project.id), 1);
  } finally {
    await cleanup([project.id]);
  }
});

test("duplicate idempotency key returns the existing deployment", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`cc-replay-${Date.now()}`);
  try {
    const key = `cc-replay-key-${Date.now()}`;
    const first = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: key,
    });
    const second = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: key,
    });
    assert.equal(second.id, first.id);
    assert.equal(await nonTerminalCount(project.id), 1);
  } finally {
    await cleanup([project.id]);
  }
});

test("concurrent same-project requests create exactly one deployment", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`cc-race-${Date.now()}`);
  try {
    const stamp = Date.now();
    const outcomes = await Promise.allSettled(
      [0, 1, 2, 3, 4].map((i) =>
        createDeployment({
          projectId: project.id,
          trigger: "manual",
          idempotencyKey: `cc-race-${stamp}-${i}`,
        })
      )
    );
    const won = outcomes.filter((o) => o.status === "fulfilled");
    const lost = outcomes.filter((o) => o.status === "rejected");
    assert.equal(won.length, 1);
    assert.equal(lost.length, 4);
    for (const loser of lost) {
      assert.ok(
        (loser as PromiseRejectedResult).reason instanceof
          DeploymentConflictError
      );
    }
    assert.equal(await nonTerminalCount(project.id), 1);
  } finally {
    await cleanup([project.id]);
  }
});

test("different projects deploy concurrently without conflict", async () => {
  if (!(await dbAvailable())) return;
  const stamp = Date.now();
  const a = await createProject(`cc-a-${stamp}`);
  const b = await createProject(`cc-b-${stamp}`);
  try {
    const [depA, depB] = await Promise.all([
      createDeployment({
        projectId: a.id,
        trigger: "manual",
        idempotencyKey: `cc-a-key-${stamp}`,
      }),
      createDeployment({
        projectId: b.id,
        trigger: "manual",
        idempotencyKey: `cc-b-key-${stamp}`,
      }),
    ]);
    assert.ok(depA?.id);
    assert.ok(depB?.id);
    assert.notEqual(depA.id, depB.id);
  } finally {
    await cleanup([a.id, b.id]);
  }
});

test("terminal deployment does not block a new deployment", async () => {
  if (!(await dbAvailable())) return;
  const project = await createProject(`cc-terminal-${Date.now()}`);
  try {
    const first = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: `cc-t1-${Date.now()}`,
    });
    await cancelDeployment(first.id);
    const second = await createDeployment({
      projectId: project.id,
      trigger: "manual",
      idempotencyKey: `cc-t2-${Date.now()}`,
    });
    assert.ok(second?.id);
    assert.notEqual(second.id, first.id);
  } finally {
    await cleanup([project.id]);
  }
});
