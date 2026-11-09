import test from "node:test";
import assert from "node:assert/strict";
import pool from "../db/database.js";
import { gateDb } from "../test/dbGate.js";
import { createProject, deleteProject, updateProject, ProjectError } from "./projectService.js";
import {
  createProjectEnvVar,
  getProjectEnvVars,
  getProjectRuntimeEnv,
  updateProjectEnvVar,
  deleteProjectEnvVar,
  MASKED_SECRET_VALUE,
  EnvVarError,
} from "./envVarService.js";
import { decryptSecret } from "../security/encryption.js";
import { RealDeploymentExecutor } from "../workers/deploymentPipeline.js";
import { PIPELINE_ERROR_CODES, PipelineError } from "../deployments/deploymentErrors.js";
import { createRelease } from "./releaseService.js";

const SUITE = "services/envVarService.db.unit.test.ts";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.project_env_vars') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

const trackedProjectIds: string[] = [];

async function makeProject(name = "test-project") {
  const p = await createProject({
    name,
    repositoryUrl: "https://github.com/acme/repo.git",
    branch: "main",
  });
  trackedProjectIds.push(p.id);
  return p;
}

test("envVarService & project update database tests", async (t) => {
  const ok = await gateDb(SUITE, dbAvailable);
  if (!ok) {
    t.skip("Database or project_env_vars table not available");
    return;
  }

  t.after(async () => {
    if (trackedProjectIds.length > 0) {
      await pool.query(`DELETE FROM projects WHERE id = ANY($1)`, [trackedProjectIds]);
      trackedProjectIds.length = 0;
    }
  });

  await t.test("updateProject updates name and branch", async () => {
    const project = await makeProject("original-name");
    assert.equal(project.name, "original-name");
    assert.equal(project.branch, "main");

    const updated = await updateProject(project.id, {
      name: "updated-name",
      branch: "release/v1",
    });
    assert.equal(updated.name, "updated-name");
    assert.equal(updated.branch, "release/v1");

    // Partial update
    const patchedName = await updateProject(project.id, {
      name: "renamed-again",
    });
    assert.equal(patchedName.name, "renamed-again");
    assert.equal(patchedName.branch, "release/v1");

    // Invalid branch validation
    await assert.rejects(
      async () => {
        await updateProject(project.id, { branch: "-bad-branch" });
      },
      (err: unknown) => err instanceof ProjectError && err.code === "INVALID_BRANCH"
    );

    // Invalid name validation
    await assert.rejects(
      async () => {
        await updateProject(project.id, { name: "" });
      },
      (err: unknown) => err instanceof ProjectError && err.code === "INVALID_NAME"
    );
  });

  await t.test("createProjectEnvVar: encryption and secret masking", async () => {
    const project = await makeProject("env-test-project");

    // Create non-secret variable
    const nonSecret = await createProjectEnvVar(project.id, {
      key: "PUBLIC_API_URL",
      value: "https://api.example.com",
      isSecret: false,
    });
    assert.equal(nonSecret.key, "PUBLIC_API_URL");
    assert.equal(nonSecret.value, "https://api.example.com");
    assert.equal(nonSecret.is_secret, false);

    // Create secret variable
    const secret = await createProjectEnvVar(project.id, {
      key: "DATABASE_PASSWORD",
      value: "super_secret_pw_123",
      isSecret: true,
    });
    assert.equal(secret.key, "DATABASE_PASSWORD");
    assert.equal(secret.value, MASKED_SECRET_VALUE);
    assert.equal(secret.is_secret, true);

    // Verify raw DB content is encrypted
    const rawRows = await pool.query(
      `SELECT key, value_encrypted, is_secret FROM project_env_vars WHERE project_id = $1 ORDER BY key`,
      [project.id]
    );
    assert.equal(rawRows.rows.length, 2);
    for (const row of rawRows.rows) {
      assert.notEqual(row.value_encrypted, "super_secret_pw_123");
      assert.notEqual(row.value_encrypted, "https://api.example.com");
      const decrypted = decryptSecret(row.value_encrypted);
      if (row.key === "DATABASE_PASSWORD") {
        assert.equal(decrypted, "super_secret_pw_123");
      } else {
        assert.equal(decrypted, "https://api.example.com");
      }
    }

    // getProjectEnvVars returns list with masked secrets
    const list = await getProjectEnvVars(project.id);
    assert.equal(list.length, 2);
    const dbPw = list.find((v) => v.key === "DATABASE_PASSWORD");
    assert.equal(dbPw?.value, MASKED_SECRET_VALUE);
    assert.equal(dbPw?.is_secret, true);
    const apiVal = list.find((v) => v.key === "PUBLIC_API_URL");
    assert.equal(apiVal?.value, "https://api.example.com");
    assert.equal(apiVal?.is_secret, false);

    // getProjectRuntimeEnv returns plaintext dictionary for runtime container
    const runtimeEnv = await getProjectRuntimeEnv(project.id);
    assert.equal(runtimeEnv.DATABASE_PASSWORD, "super_secret_pw_123");
    assert.equal(runtimeEnv.PUBLIC_API_URL, "https://api.example.com");
  });

  await t.test("rejects masked placeholder as real secret or plaintext value", async () => {
    const project = await makeProject("mask-val-project");

    // Creating secret with mask placeholder is rejected
    await assert.rejects(
      () => createProjectEnvVar(project.id, { key: "MASK_KEY", value: MASKED_SECRET_VALUE, isSecret: true }),
      (err: unknown) => err instanceof EnvVarError && err.code === "INVALID_VALUE"
    );

    // Creating plaintext with mask placeholder is rejected
    await assert.rejects(
      () => createProjectEnvVar(project.id, { key: "MASK_KEY", value: MASKED_SECRET_VALUE, isSecret: false }),
      (err: unknown) => err instanceof EnvVarError && err.code === "INVALID_VALUE"
    );

    // Updating plaintext with mask placeholder is rejected
    const createdPlain = await createProjectEnvVar(project.id, { key: "PLAIN_KEY", value: "initial", isSecret: false });
    await assert.rejects(
      () => updateProjectEnvVar(project.id, createdPlain.id, { value: MASKED_SECRET_VALUE }),
      (err: unknown) => err instanceof EnvVarError && err.code === "INVALID_VALUE"
    );
  });

  await t.test("changing secret to plaintext requires explicit replacement value", async () => {
    const project = await makeProject("unmask-guard-project");

    const secretVar = await createProjectEnvVar(project.id, {
      key: "PROTECTED_SECRET",
      value: "my_sensitive_token",
      isSecret: true,
    });

    // Attempting to flip isSecret to false without value is rejected fail-closed
    await assert.rejects(
      () => updateProjectEnvVar(project.id, secretVar.id, { isSecret: false }),
      (err: unknown) => err instanceof EnvVarError && err.code === "INVALID_VALUE"
    );

    // Attempting to flip isSecret to false with masked placeholder is rejected
    await assert.rejects(
      () => updateProjectEnvVar(project.id, secretVar.id, { isSecret: false, value: MASKED_SECRET_VALUE }),
      (err: unknown) => err instanceof EnvVarError && err.code === "INVALID_VALUE"
    );

    // Providing an explicit replacement value succeeds
    const unmasked = await updateProjectEnvVar(project.id, secretVar.id, {
      isSecret: false,
      value: "explicit_public_value",
    });
    assert.equal(unmasked.is_secret, false);
    assert.equal(unmasked.value, "explicit_public_value");

    // And now runtime returns the new explicit value
    const runtime = await getProjectRuntimeEnv(project.id);
    assert.equal(runtime.PROTECTED_SECRET, "explicit_public_value");
  });

  await t.test("key validation and reserved key enforcement", async () => {
    const project = await makeProject("val-test-project");

    // Reserved keys
    await assert.rejects(
      () => createProjectEnvVar(project.id, { key: "PORT", value: "3000" }),
      (err: unknown) => err instanceof EnvVarError && err.code === "RESERVED_KEY"
    );
    await assert.rejects(
      () => createProjectEnvVar(project.id, { key: "DEPLOYKIT_DEPLOYMENT_ID", value: "123" }),
      (err: unknown) => err instanceof EnvVarError && err.code === "RESERVED_KEY"
    );

    // Invalid key characters
    await assert.rejects(
      () => createProjectEnvVar(project.id, { key: "BAD-KEY", value: "val" }),
      (err: unknown) => err instanceof EnvVarError && err.code === "INVALID_KEY"
    );
    await assert.rejects(
      () => createProjectEnvVar(project.id, { key: "123NUM_KEY", value: "val" }),
      (err: unknown) => err instanceof EnvVarError && err.code === "INVALID_KEY"
    );
    await assert.rejects(
      () => createProjectEnvVar(project.id, { key: "KEY WITH SPACES", value: "val" }),
      (err: unknown) => err instanceof EnvVarError && err.code === "INVALID_KEY"
    );
  });

  await t.test("getProjectRuntimeEnv fails closed on decryption failure (no silent skip)", async () => {
    const project = await makeProject("fail-closed-env-project");

    await createProjectEnvVar(project.id, { key: "GOOD_VAR", value: "fine" });
    const secret = await createProjectEnvVar(project.id, { key: "BAD_VAR", value: "secret" });

    // Tamper ciphertext directly in database to simulate corrupted data or wrong pepper
    await pool.query(
      `UPDATE project_env_vars SET value_encrypted = 'v1:012345678901234567890123:01234567890123456789012345678901:deadbeef' WHERE id = $1`,
      [secret.id]
    );

    // Must throw typed error and not return partial dictionary
    await assert.rejects(
      () => getProjectRuntimeEnv(project.id),
      (err: unknown) => {
        assert.ok(err instanceof EnvVarError);
        assert.equal(err.code, "ENV_DECRYPTION_FAILED");
        assert.ok(err.message.includes("BAD_VAR"));
        // Ensure no ciphertext is leaked in error message
        assert.ok(!err.message.includes("deadbeef"));
        return true;
      }
    );
  });

  await t.test("deployment pipeline fails closed when env var decryption fails", async () => {
    const project = await makeProject("pipeline-failclosed-env");
    const secret = await createProjectEnvVar(project.id, { key: "CORRUPT_SECRET", value: "val" });

    // Corrupt ciphertext in DB
    await pool.query(
      `UPDATE project_env_vars SET value_encrypted = 'v1:012345678901234567890123:01234567890123456789012345678901:deadbeef' WHERE id = $1`,
      [secret.id]
    );

    // Create initial deployment and target release for rollback
    const initDepRes = await pool.query(
      `INSERT INTO deployments (project_id, status, trigger, branch) VALUES ($1, 'active', 'manual', 'main') RETURNING *`,
      [project.id]
    );
    const initDep = initDepRes.rows[0];

    const release = await createRelease({
      deploymentId: initDep.id,
      projectId: project.id,
      imageRepository: "deploykit/test",
      imageDigest: `sha256:${"b".repeat(64)}`,
      commitSha: "1111111111111111111111111111111111111111",
      branch: "main",
      supersedesReleaseId: null,
    });

    // Create rollback deployment referencing target release
    const rollbackDepRes = await pool.query(
      `INSERT INTO deployments (project_id, status, trigger, branch, rollback_release_id)
       VALUES ($1, 'cloning', 'rollback', 'main', $2) RETURNING *`,
      [project.id, release.id]
    );
    const dep = rollbackDepRes.rows[0];

    let runtimeCreated = false;
    const fakeRuntimeManager = {
      create: async () => {
        runtimeCreated = true;
        return { containerName: "dummy", containerPort: 3000, ipAddress: "127.0.0.1", hostPort: 3000 };
      },
      start: async () => {},
      inspect: async () => ({ containerName: "dummy", containerPort: 3000, ipAddress: "127.0.0.1", hostPort: 3000 }),
      remove: async () => {},
      isRunning: async () => true,
    };

    const executor = new RealDeploymentExecutor({
      runtimeManager: fakeRuntimeManager as any,
    });

    await assert.rejects(
      async () => {
        await executor.execute({
          deploymentId: dep.id,
          jobId: "job-rollback-test",
          attempt: 1,
          maxAttempts: 3,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof PipelineError);
        assert.equal(err.code, PIPELINE_ERROR_CODES.RUNTIME_FAILED);
        assert.equal(err.retryable, false);
        return true;
      }
    );

    // Ensure container was NOT created
    assert.equal(runtimeCreated, false);

    // Ensure deployment event was recorded
    const eventRes = await pool.query(
      `SELECT event_type, message FROM deployment_events WHERE deployment_id = $1 AND event_type = 'deployment.env_failed'`,
      [dep.id]
    );
    assert.equal(eventRes.rowCount, 1);
    assert.ok(eventRes.rows[0].message.includes("CORRUPT_SECRET"));
  });

  await t.test("uniqueness per project and tenant isolation", async () => {
    const projectA = await makeProject("project-a");
    const projectB = await makeProject("project-b");

    // Both can have the same key
    await createProjectEnvVar(projectA.id, { key: "SHARED_KEY", value: "val-a" });
    const bVar = await createProjectEnvVar(projectB.id, { key: "SHARED_KEY", value: "val-b" });
    assert.equal(bVar.key, "SHARED_KEY");

    // Duplicate in same project rejected
    await assert.rejects(
      () => createProjectEnvVar(projectA.id, { key: "SHARED_KEY", value: "duplicate" }),
      (err: unknown) => err instanceof EnvVarError && err.code === "DUPLICATE_KEY"
    );

    // Tenant isolation: cannot update/delete var belonging to project B using project A's id
    await assert.rejects(
      () => updateProjectEnvVar(projectA.id, bVar.id, { value: "hacked" }),
      (err: unknown) => err instanceof EnvVarError && err.code === "NOT_FOUND"
    );
    const deletedOther = await deleteProjectEnvVar(projectA.id, bVar.id);
    assert.equal(deletedOther, false);
  });

  await t.test("updateProjectEnvVar preserves secret ciphertext when value unchanged", async () => {
    const project = await makeProject("update-env-project");

    const created = await createProjectEnvVar(project.id, {
      key: "SECRET_TOKEN",
      value: "original_unmasked_secret",
      isSecret: true,
    });

    // Update key while passing masked value
    const updated = await updateProjectEnvVar(project.id, created.id, {
      key: "RENAMED_SECRET_TOKEN",
      value: MASKED_SECRET_VALUE,
    });
    assert.equal(updated.key, "RENAMED_SECRET_TOKEN");
    assert.equal(updated.value, MASKED_SECRET_VALUE);

    // Decrypt directly to verify the original secret wasn't replaced with the mask characters
    const runtime = await getProjectRuntimeEnv(project.id);
    assert.equal(runtime.RENAMED_SECRET_TOKEN, "original_unmasked_secret");

    // Now update with real new value
    await updateProjectEnvVar(project.id, created.id, {
      value: "new_secret_val",
    });
    const runtimeNew = await getProjectRuntimeEnv(project.id);
    assert.equal(runtimeNew.RENAMED_SECRET_TOKEN, "new_secret_val");
  });

  await t.test("deleteProjectEnvVar and cascading deletion on project delete", async () => {
    const project = await makeProject("cascade-project");
    const v = await createProjectEnvVar(project.id, { key: "TEMP_KEY", value: "abc" });

    // Delete single var
    const deleted = await deleteProjectEnvVar(project.id, v.id);
    assert.equal(deleted, true);
    const remaining = await getProjectEnvVars(project.id);
    assert.equal(remaining.length, 0);

    // Add another var, then delete project
    await createProjectEnvVar(project.id, { key: "CASCADE_KEY", value: "xyz" });
    await deleteProject(project.id);

    // Verify row was deleted by cascade
    const check = await pool.query(`SELECT * FROM project_env_vars WHERE project_id = $1`, [project.id]);
    assert.equal(check.rowCount, 0);
  });
});
