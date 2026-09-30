import pool from "../db/database.js";

export class GitHubLinkError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "GitHubLinkError";
    this.code = code;
    this.status = status;
  }
}

const FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validateFullName(fullName: string): string {
  const value = fullName.trim();
  if (!FULL_NAME_PATTERN.test(value) || value.length > 320) {
    throw new GitHubLinkError("INVALID_REPOSITORY", "Invalid repository full_name");
  }
  return value;
}

export function validateInstallationId(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!/^\d{1,20}$/.test(value)) {
    throw new GitHubLinkError("INVALID_INSTALLATION", "Invalid installation ID");
  }
  return value;
}

export async function linkProjectRepository(input: {
  projectId: string;
  installationId: string;
  repositoryFullName: string;
  repositoryId?: number | null;
  autoDeploy?: boolean;
}): Promise<{ project: unknown; repository: unknown }> {
  const fullName = validateFullName(input.repositoryFullName);
  const installationRef = validateInstallationId(input.installationId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const project = await client.query(`SELECT * FROM projects WHERE id = $1 FOR UPDATE`, [
      input.projectId,
    ]);
    if (project.rowCount === 0) {
      throw new GitHubLinkError("PROJECT_NOT_FOUND", "Project not found", 404);
    }
    const installationIdNum = Number(installationRef);
    let installation = await client.query(
      `SELECT * FROM github_installations WHERE github_installation_id = $1`,
      [installationIdNum]
    );
    if (installation.rowCount === 0) {
      installation = await client.query(
        `INSERT INTO github_installations (github_installation_id) VALUES ($1) RETURNING *`,
        [installationIdNum]
      );
    }
    const installationDbId = installation.rows[0].id as string;
    let repo = await client.query(
      `SELECT * FROM github_repositories WHERE lower(full_name) = lower($1)`,
      [fullName]
    );
    if (repo.rowCount === 0) {
      repo = await client.query(
        `INSERT INTO github_repositories (github_repo_id, installation_id, full_name)
         VALUES ($1, $2, $3) RETURNING *`,
        [input.repositoryId ?? null, installationDbId, fullName]
      );
    } else {
      // Re-point to the current installation; a repo belongs to one installation.
      await client.query(
        `UPDATE github_repositories SET installation_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [repo.rows[0].id, installationDbId]
      );
      repo = await client.query(`SELECT * FROM github_repositories WHERE id = $1`, [
        repo.rows[0].id,
      ]);
    }
    const autoDeploy = input.autoDeploy ?? true;
    const updated = await client.query(
      `UPDATE projects SET github_repository_id = $2, auto_deploy = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [input.projectId, repo.rows[0].id, autoDeploy]
    );
    await client.query("COMMIT");
    return { project: updated.rows[0], repository: repo.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getProjectGitHubLink(projectId: string): Promise<unknown | null> {
  const result = await pool.query(
    `SELECT p.id AS project_id, p.auto_deploy, p.branch,
            r.id AS repository_id, r.full_name, r.private,
            i.github_installation_id AS installation_id
     FROM projects p
     LEFT JOIN github_repositories r ON r.id = p.github_repository_id
     LEFT JOIN github_installations i ON i.id = r.installation_id
     WHERE p.id = $1`,
    [projectId]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  if (!row.repository_id) return { project_id: row.project_id, linked: false };
  return { ...row, linked: true };
}

export async function unlinkProjectRepository(projectId: string): Promise<void> {
  await pool.query(
    `UPDATE projects SET github_repository_id = NULL, auto_deploy = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [projectId]
  );
}
