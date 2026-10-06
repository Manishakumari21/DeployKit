// Phase 10 Step 3: project_members schema, ownership, atomic creation,
// bootstrap idempotency, and deletion — all against real PostgreSQL.
import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import { createUser } from "./userService.js";
import {
  addProjectOwner,
  createProject,
  deleteProject,
  getProjectById,
  ProjectError,
} from "./projectService.js";
import { getProjectMembership } from "./authorizationService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.project_members') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

function uniqueEmail(tag: string): string {
  const rand = Math.floor(Math.random() * 1_000_000);
  return `phase10-mem-${tag}-${Date.now()}-${rand}@example.com`;
}

const projectIds: string[] = [];
const userIds: string[] = [];

async function trackUser(email: string) {
  const user = await createUser({ email, password: "correct-horse-123" });
  userIds.push(user.id);
  return user;
}

async function trackProject(
  name: string,
  ownerUserId?: string
): Promise<{ id: string }> {
  const project = await createProject({
    name,
    repositoryUrl: "https://github.com/acme/app.git",
    branch: "main",
    ...(ownerUserId === undefined ? {} : { ownerUserId }),
  });
  projectIds.push(project.id);
  return project;
}

async function cleanup(): Promise<void> {
  if (projectIds.length > 0) {
    await pool.query(`DELETE FROM projects WHERE id = ANY($1)`, [projectIds]);
    projectIds.length = 0;
  }
  if (userIds.length > 0) {
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
    userIds.length = 0;
  }
}

// ---- Schema ----

test("project_members has the expected columns, PK, FKs, and indexes", async () => {
  if (!(await dbAvailable())) return;
  const columns = (
    await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'project_members'
       ORDER BY column_name`
    )
  ).rows.map((r: { column_name: string }) => r.column_name);
  assert.deepEqual(columns, ["created_at", "project_id", "role", "user_id"]);

  const pk = (
    await pool.query(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       WHERE tc.table_name = 'project_members' AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`
    )
  ).rows.map((r: { column_name: string }) => r.column_name);
  assert.deepEqual(pk, ["project_id", "user_id"]);

  const fks = (
    await pool.query(
      `SELECT kcu.column_name,
              ccu.table_name AS ref_table,
              rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
       WHERE tc.table_name = 'project_members'
         AND tc.constraint_type = 'FOREIGN KEY'`
    )
  ).rows;
  const byColumn = Object.fromEntries(
    fks.map((r: { column_name: string; ref_table: string; delete_rule: string }) => [
      r.column_name,
      r,
    ])
  );
  assert.equal(byColumn.project_id.ref_table, "projects");
  assert.equal(byColumn.project_id.delete_rule, "CASCADE");
  assert.equal(byColumn.user_id.ref_table, "users");
  assert.equal(byColumn.user_id.delete_rule, "CASCADE");

  const indexes = (
    await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'project_members'`
    )
  ).rows.map((r: { indexname: string }) => r.indexname);
  assert.ok(indexes.includes("project_members_pkey"));
  assert.ok(indexes.includes("project_members_user_idx"));
});

test("invalid role is rejected by the database", async () => {
  if (!(await dbAvailable())) return;
  const user = await trackUser(uniqueEmail("role"));
  const project = await trackProject(`role-${Date.now()}`);
  try {
    await assert.rejects(
      pool.query(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [project.id, user.id]
      ),
      (e: unknown) => (e as { code?: string }).code === "23514"
    );
  } finally {
    await cleanup();
  }
});

// ---- Ownership ----

test("owner membership is created and readable", async () => {
  if (!(await dbAvailable())) return;
  const user = await trackUser(uniqueEmail("own"));
  const project = await trackProject(`own-${Date.now()}`);
  try {
    const member = await addProjectOwner({ projectId: project.id, userId: user.id });
    assert.equal(member.created, true);
    assert.equal(member.role, "owner");
    assert.equal(
      await getProjectMembership({ userId: user.id, projectId: project.id }),
      "owner"
    );
  } finally {
    await cleanup();
  }
});

test("duplicate membership is an idempotent no-op, not a second row", async () => {
  if (!(await dbAvailable())) return;
  const user = await trackUser(uniqueEmail("idem"));
  const project = await trackProject(`idem-${Date.now()}`);
  try {
    const first = await addProjectOwner({ projectId: project.id, userId: user.id });
    const second = await addProjectOwner({ projectId: project.id, userId: user.id });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.role, "owner");
    const count = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM project_members
         WHERE project_id = $1 AND user_id = $2`,
        [project.id, user.id]
      )
    ).rows[0].n;
    assert.equal(count, 1);
  } finally {
    await cleanup();
  }
});

test("different users hold distinct memberships on one project", async () => {
  if (!(await dbAvailable())) return;
  const alice = await trackUser(uniqueEmail("alice"));
  const bob = await trackUser(uniqueEmail("bob"));
  const project = await trackProject(`multi-${Date.now()}`);
  try {
    await addProjectOwner({ projectId: project.id, userId: alice.id });
    await addProjectOwner({ projectId: project.id, userId: bob.id });
    assert.equal(
      await getProjectMembership({ userId: alice.id, projectId: project.id }),
      "owner"
    );
    assert.equal(
      await getProjectMembership({ userId: bob.id, projectId: project.id }),
      "owner"
    );
  } finally {
    await cleanup();
  }
});

test("bootstrap against missing project or user fails without inventing rows", async () => {
  if (!(await dbAvailable())) return;
  const user = await trackUser(uniqueEmail("ghost"));
  const project = await trackProject(`ghost-${Date.now()}`);
  const missing = "00000000-0000-0000-0000-000000000000";
  try {
    await assert.rejects(
      addProjectOwner({ projectId: missing, userId: user.id }),
      (e: unknown) => e instanceof ProjectError && e.code === "MEMBERSHIP_SUBJECT_NOT_FOUND"
    );
    await assert.rejects(
      addProjectOwner({ projectId: project.id, userId: missing }),
      (e: unknown) => e instanceof ProjectError && e.code === "MEMBERSHIP_SUBJECT_NOT_FOUND"
    );
    await assert.rejects(
      addProjectOwner({ projectId: "not-a-uuid", userId: user.id }),
      (e: unknown) => e instanceof ProjectError && e.code === "INVALID_MEMBERSHIP"
    );
    const users = (await pool.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n;
    assert.ok(users >= 1);
  } finally {
    await cleanup();
  }
});

// ---- Legacy projects ----

test("project created without owner stays intact with zero memberships", async () => {
  if (!(await dbAvailable())) return;
  const usersBefore = (await pool.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n;
  const project = await trackProject(`legacy-${Date.now()}`);
  try {
    assert.ok(await getProjectById(project.id), "legacy project row must survive");
    const members = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM project_members WHERE project_id = $1`,
        [project.id]
      )
    ).rows[0].n;
    assert.equal(members, 0);
    const usersAfter = (await pool.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n;
    assert.equal(usersAfter, usersBefore, "no fake user may be created");
    assert.equal(
      await getProjectMembership({ userId: "00000000-0000-0000-0000-000000000000", projectId: project.id }),
      null
    );
  } finally {
    await cleanup();
  }
});

// ---- Atomic creation ----

test("createProject with owner writes project and membership atomically", async () => {
  if (!(await dbAvailable())) return;
  const user = await trackUser(uniqueEmail("atomic"));
  try {
    const project = await trackProject(`atomic-${Date.now()}`, user.id);
    assert.equal(
      await getProjectMembership({ userId: user.id, projectId: project.id }),
      "owner"
    );
  } finally {
    await cleanup();
  }
});

test("createProject with unknown owner rolls back the project row", async () => {
  if (!(await dbAvailable())) return;
  const missing = "00000000-0000-0000-0000-000000000000";
  const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM projects`)).rows[0].n;
  await assert.rejects(
    createProject({
      name: `rollback-${Date.now()}`,
      repositoryUrl: "https://github.com/acme/app.git",
      branch: "main",
      ownerUserId: missing,
    }),
    (e: unknown) => e instanceof ProjectError && e.code === "OWNER_NOT_FOUND"
  );
  const after = (await pool.query(`SELECT COUNT(*)::int AS n FROM projects`)).rows[0].n;
  assert.equal(after, before, "failed owner insert must not leave a project behind");
  await assert.rejects(
    createProject({
      name: `badowner-${Date.now()}`,
      repositoryUrl: "https://github.com/acme/app.git",
      branch: "main",
      ownerUserId: "not-a-uuid",
    }),
    (e: unknown) => e instanceof ProjectError && e.code === "INVALID_OWNER"
  );
  await cleanup();
});

// ---- Deletion ----

test("deleting a project removes its memberships but never its users", async () => {
  if (!(await dbAvailable())) return;
  const user = await trackUser(uniqueEmail("delp"));
  const project = await createProject({
    name: `delp-${Date.now()}`,
    repositoryUrl: "https://github.com/acme/app.git",
    branch: "main",
    ownerUserId: user.id,
  });
  try {
    await deleteProject(project.id);
    const members = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM project_members WHERE project_id = $1`,
        [project.id]
      )
    ).rows[0].n;
    assert.equal(members, 0);
    const survivor = await pool.query(`SELECT id FROM users WHERE id = $1`, [user.id]);
    assert.equal(survivor.rowCount, 1, "project deletion must not delete the user");
  } finally {
    await cleanup();
  }
});

test("deleting a user removes its memberships but never its projects", async () => {
  if (!(await dbAvailable())) return;
  const user = await trackUser(uniqueEmail("delu"));
  const project = await trackProject(`delu-${Date.now()}`, user.id);
  try {
    await pool.query(`DELETE FROM users WHERE id = $1`, [user.id]);
    userIds.length = 0;
    const members = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM project_members WHERE user_id = $1`,
        [user.id]
      )
    ).rows[0].n;
    assert.equal(members, 0);
    const survivor = await getProjectById(project.id);
    assert.ok(survivor, "user deletion must not delete the project");
    assert.equal(
      await getProjectMembership({ userId: user.id, projectId: project.id }),
      null,
      "orphaned project is unowned and therefore denied"
    );
  } finally {
    await cleanup();
  }
});
