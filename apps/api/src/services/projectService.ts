import pool from "../db/database.js";
import { withTransaction } from "../db/transaction.js";

export class ProjectError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
    this.status = status;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateProjectInput {
  name: string;
  repositoryUrl: string;
  branch: string;

  ownerUserId?: string;
}

function validateOwnerId(ownerUserId: string): string {
  if (!UUID_PATTERN.test(ownerUserId)) {
    throw new ProjectError("INVALID_OWNER", "Invalid owner user id");
  }
  return ownerUserId;
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23503"
  );
}

export async function createProject(input: CreateProjectInput) {
  if (input.ownerUserId === undefined) {
    const result = await pool.query(
      `
      INSERT INTO projects (name, repository_url, branch)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [input.name, input.repositoryUrl, input.branch]
    );

    return result.rows[0];
  }

  const ownerUserId = validateOwnerId(input.ownerUserId);
  try {
    return await withTransaction(async (client) => {
      const project = (
        await client.query(
          `
          INSERT INTO projects (name, repository_url, branch)
          VALUES ($1, $2, $3)
          RETURNING *
          `,
          [input.name, input.repositoryUrl, input.branch]
        )
      ).rows[0];
      await client.query(
        `
        INSERT INTO project_members (project_id, user_id, role)
        VALUES ($1, $2, 'owner')
        `,
        [project.id, ownerUserId]
      );
      return project;
    });
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw new ProjectError("OWNER_NOT_FOUND", "Owner user not found", 404);
    }
    throw error;
  }
}

export async function getProjects() {
  const result = await pool.query(
    `
    SELECT *
    FROM projects
    ORDER BY created_at DESC
    `
  );

  return result.rows;
}

export async function getProjectsForUser(userId: string) {
  const result = await pool.query(
    `
    SELECT p.*
    FROM projects p
    JOIN project_members m ON m.project_id = p.id
    WHERE m.user_id = $1
    ORDER BY p.created_at DESC
    `,
    [userId]
  );

  return result.rows;
}

export async function getProjectById(id: string) {
  const result = await pool.query(
    `
    SELECT *
    FROM projects
    WHERE id = $1
    `,
    [id]
  );

  return result.rows[0] ?? null;
}

export async function deleteProject(id: string) {
  const result = await pool.query(
    `
    DELETE FROM projects
    WHERE id = $1
    RETURNING *
    `,
    [id]
  );

  return result.rows[0] ?? null;
}

export interface ProjectMembership {
  project_id: string;
  user_id: string;
  role: string;
  created_at: string;
  created: boolean;
}

export async function addProjectOwner(input: {
  projectId: string;
  userId: string;
}): Promise<ProjectMembership> {
  if (!UUID_PATTERN.test(input.projectId) || !UUID_PATTERN.test(input.userId)) {
    throw new ProjectError("INVALID_MEMBERSHIP", "Invalid project or user id");
  }
  try {
    const inserted = await pool.query(
      `
      INSERT INTO project_members (project_id, user_id, role)
      VALUES ($1, $2, 'owner')
      ON CONFLICT (project_id, user_id) DO NOTHING
      RETURNING project_id, user_id, role, created_at
      `,
      [input.projectId, input.userId]
    );
    if (inserted.rowCount === 1) {
      const row = inserted.rows[0] as Omit<ProjectMembership, "created">;
      return { ...row, created: true };
    }
    const existing = await pool.query(
      `
      SELECT project_id, user_id, role, created_at
      FROM project_members
      WHERE project_id = $1 AND user_id = $2
      `,
      [input.projectId, input.userId]
    );
    const row = existing.rows[0] as Omit<ProjectMembership, "created">;
    return { ...row, created: false };
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw new ProjectError(
        "MEMBERSHIP_SUBJECT_NOT_FOUND",
        "Project or user not found",
        404
      );
    }
    throw error;
  }
}