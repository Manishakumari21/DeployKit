import pool from "../db/database.js";

export interface CreateProjectInput {
  name: string;
  repositoryUrl: string;
  branch: string;
}

export async function createProject(input: CreateProjectInput) {
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