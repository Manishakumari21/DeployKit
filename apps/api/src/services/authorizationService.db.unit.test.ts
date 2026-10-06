// Phase 10 Step 3: authorization decisions — database-backed, fail closed.
// No sessions or routes here; user ids are passed explicitly as the future
// auth layer will supply them from server-side request context.
import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import { createUser } from "./userService.js";
import { addProjectOwner, createProject } from "./projectService.js";
import {
  AuthorizationError,
  getProjectMembership,
  hasProjectAccess,
  requireProjectMembership,
  requireProjectRole,
} from "./authorizationService.js";

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
  return `phase10-authz-${tag}-${Date.now()}-${rand}@example.com`;
}

const projectIds: string[] = [];
const userIds: string[] = [];

async function makeUser(tag: string) {
  const user = await createUser({ email: uniqueEmail(tag), password: "correct-horse-123" });
  userIds.push(user.id);
  return user;
}

async function makeProject(name: string, ownerUserId?: string) {
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

async function isDenied(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch (e) {
    return (
      e instanceof AuthorizationError &&
      e.code === "PROJECT_FORBIDDEN" &&
      e.status === 403
    );
  }
}

test("owner is authorized; get/has/require agree", async () => {
  if (!(await dbAvailable())) return;
  const user = await makeUser("owner");
  const project = await makeProject(`authz-own-${Date.now()}`, user.id);
  try {
    assert.equal(
      await getProjectMembership({ userId: user.id, projectId: project.id }),
      "owner"
    );
    assert.equal(await hasProjectAccess({ userId: user.id, projectId: project.id }), true);
    assert.equal(
      await hasProjectAccess({ userId: user.id, projectId: project.id, role: "owner" }),
      true
    );
    assert.equal(
      await requireProjectMembership({ userId: user.id, projectId: project.id }),
      "owner"
    );
    assert.equal(await requireProjectRole(user.id, project.id, "owner"), "owner");
  } finally {
    await cleanup();
  }
});

test("non-member is denied on every primitive", async () => {
  if (!(await dbAvailable())) return;
  const owner = await makeUser("own1");
  const stranger = await makeUser("stranger");
  const project = await makeProject(`authz-str-${Date.now()}`, owner.id);
  try {
    assert.equal(
      await getProjectMembership({ userId: stranger.id, projectId: project.id }),
      null
    );
    assert.equal(
      await hasProjectAccess({ userId: stranger.id, projectId: project.id }),
      false
    );
    assert.equal(await isDenied(requireProjectMembership({ userId: stranger.id, projectId: project.id })), true);
    assert.equal(await isDenied(requireProjectRole(stranger.id, project.id, "owner")), true);
  } finally {
    await cleanup();
  }
});

test("unknown project, unknown user, and empty ids all deny", async () => {
  if (!(await dbAvailable())) return;
  const user = await makeUser("known");
  const project = await makeProject(`authz-unk-${Date.now()}`, user.id);
  const missing = "00000000-0000-0000-0000-000000000000";
  try {
    assert.equal(await getProjectMembership({ userId: user.id, projectId: missing }), null);
    assert.equal(await getProjectMembership({ userId: missing, projectId: project.id }), null);
    assert.equal(
      await hasProjectAccess({ userId: "", projectId: project.id }),
      false
    );
    assert.equal(await isDenied(requireProjectMembership({ userId: user.id, projectId: missing })), true);
    assert.equal(await isDenied(requireProjectMembership({ userId: missing, projectId: project.id })), true);
  } finally {
    await cleanup();
  }
});

test("unowned legacy project denies even its creator-era callers", async () => {
  if (!(await dbAvailable())) return;
  const user = await makeUser("legacy");
  const project = await makeProject(`authz-leg-${Date.now()}`);
  try {
    assert.equal(
      await getProjectMembership({ userId: user.id, projectId: project.id }),
      null
    );
    assert.equal(
      await hasProjectAccess({ userId: user.id, projectId: project.id }),
      false
    );
    assert.equal(await isDenied(requireProjectMembership({ userId: user.id, projectId: project.id })), true);
    // Explicit bootstrap flips the decision without touching anything else.
    await addProjectOwner({ projectId: project.id, userId: user.id });
    assert.equal(
      await hasProjectAccess({ userId: user.id, projectId: project.id }),
      true
    );
  } finally {
    await cleanup();
  }
});

test("unknown required role denies instead of throwing a 500", async () => {
  if (!(await dbAvailable())) return;
  const user = await makeUser("role");
  const project = await makeProject(`authz-role-${Date.now()}`, user.id);
  try {
    assert.equal(
      await hasProjectAccess({
        userId: user.id,
        projectId: project.id,
        role: "superadmin" as never,
      }),
      false
    );
    assert.equal(
      await isDenied(
        requireProjectMembership({
          userId: user.id,
          projectId: project.id,
          role: "superadmin" as never,
        })
      ),
      true
    );
  } finally {
    await cleanup();
  }
});
