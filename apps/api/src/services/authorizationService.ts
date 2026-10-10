

import pool from "../db/database.js";

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

export async function requireDomainAccess(
  userId: string,
  domainId: string
): Promise<{ projectId: string }> {
  const row = (
    await pool.query(`SELECT project_id FROM custom_domains WHERE id = $1`, [
      domainId,
    ])
  ).rows[0] as { project_id: string } | undefined;
  if (!row) {
    throw new AuthorizationError("DOMAIN_NOT_FOUND", "Domain not found", 404);
  }
  await requireProjectMembership({ userId, projectId: row.project_id });
  return { projectId: row.project_id };
}
