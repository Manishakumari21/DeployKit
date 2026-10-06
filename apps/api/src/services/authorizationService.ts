// Phase 10 Step 3: database-backed project authorization primitives.
// Reads membership only; writes live in projectService. No sessions here:
// callers pass the authenticated user id supplied by the future auth layer.
// Every decision fails closed: unknown project, unknown user, non-member,
// unowned legacy project (zero member rows), or unknown role all deny.

import pool from "../db/database.js";

// Single role today. New roles extend this tuple and ROLE_RANK; no controller
// or query changes are needed because checks compare rank, not strings.
export const PROJECT_ROLES = ["owner"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

const ROLE_RANK: Record<ProjectRole, number> = {
  owner: 100,
};

export class AuthorizationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 403) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
    this.status = status;
  }
}

function isProjectRole(value: unknown): value is ProjectRole {
  return (
    typeof value === "string" &&
    (PROJECT_ROLES as readonly string[]).includes(value)
  );
}

// One targeted query; selects role only. Null uniformly covers unknown
// project, unknown user, non-member, and unowned legacy projects, so callers
// cannot distinguish (and leak) project existence from this result alone.
export async function getProjectMembership(input: {
  userId: string;
  projectId: string;
}): Promise<ProjectRole | null> {
  if (!input.userId || !input.projectId) return null;
  const result = await pool.query(
    `
    SELECT role
    FROM project_members
    WHERE project_id = $1 AND user_id = $2
    LIMIT 1
    `,
    [input.projectId, input.userId]
  );
  const role: unknown = result.rows[0]?.role;
  return isProjectRole(role) ? role : null;
}

export async function hasProjectAccess(input: {
  userId: string;
  projectId: string;
  role?: ProjectRole;
}): Promise<boolean> {
  const membership = await getProjectMembership(input);
  if (membership === null) return false;
  if (input.role === undefined) return true;
  if (!isProjectRole(input.role)) return false;
  return ROLE_RANK[membership] >= ROLE_RANK[input.role];
}

// Throws AuthorizationError (403 PROJECT_FORBIDDEN) on any deny, so route
// handlers authorize in one line without inventing their own queries.
export async function requireProjectMembership(input: {
  userId: string;
  projectId: string;
  role?: ProjectRole;
}): Promise<ProjectRole> {
  const membership = await getProjectMembership(input);
  if (membership === null) {
    throw new AuthorizationError("PROJECT_FORBIDDEN", "Access denied");
  }
  if (input.role !== undefined) {
    if (!isProjectRole(input.role)) {
      throw new AuthorizationError("PROJECT_FORBIDDEN", "Access denied");
    }
    if (ROLE_RANK[membership] < ROLE_RANK[input.role]) {
      throw new AuthorizationError("PROJECT_FORBIDDEN", "Access denied");
    }
  }
  return membership;
}

export async function requireProjectRole(
  userId: string,
  projectId: string,
  role: ProjectRole
): Promise<ProjectRole> {
  return requireProjectMembership({ userId, projectId, role });
}

// Deployment/release routes carry only their own id, so they resolve the
// owning project first and then apply the same membership decision. Unknown
// ids stay 404 (existing API convention); existing-but-forbidden stays 403.
export async function requireDeploymentAccess(
  userId: string,
  deploymentId: string
): Promise<{ projectId: string }> {
  const row = (
    await pool.query(`SELECT project_id FROM deployments WHERE id = $1`, [
      deploymentId,
    ])
  ).rows[0] as { project_id: string } | undefined;
  if (!row) {
    throw new AuthorizationError("DEPLOYMENT_NOT_FOUND", "Deployment not found", 404);
  }
  await requireProjectMembership({ userId, projectId: row.project_id });
  return { projectId: row.project_id };
}

export async function requireReleaseAccess(
  userId: string,
  releaseId: string
): Promise<{ projectId: string }> {
  const row = (
    await pool.query(`SELECT project_id FROM releases WHERE id = $1`, [releaseId])
  ).rows[0] as { project_id: string } | undefined;
  if (!row) {
    throw new AuthorizationError("RELEASE_NOT_FOUND", "Release not found", 404);
  }
  await requireProjectMembership({ userId, projectId: row.project_id });
  return { projectId: row.project_id };
}
