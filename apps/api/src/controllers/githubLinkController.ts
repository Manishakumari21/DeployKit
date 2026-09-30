import type { Request, Response } from "express";
import { z } from "zod";
import {
  getProjectGitHubLink,
  linkProjectRepository,
  unlinkProjectRepository,
  GitHubLinkError,
} from "../services/githubLinkService.js";

const uuidSchema = z.string().uuid();

const linkSchema = z.object({
  installationId: z.union([z.string(), z.number()]).transform((v) => String(v)),
  repositoryFullName: z.string().min(3).max(320),
  repositoryId: z.number().int().positive().optional(),
  autoDeploy: z.boolean().optional(),
});

export async function linkProjectGithubController(req: Request, res: Response): Promise<void> {
  const id = uuidSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const body = linkSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid GitHub link payload" });
    return;
  }
  try {
    const result = await linkProjectRepository({
      projectId: id.data,
      installationId: body.data.installationId,
      repositoryFullName: body.data.repositoryFullName,
      repositoryId: body.data.repositoryId ?? null,
      autoDeploy: body.data.autoDeploy,
    });
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof GitHubLinkError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error("GitHub link error");
    res.status(500).json({ error: "Failed to link repository" });
  }
}

export async function getProjectGithubLinkController(req: Request, res: Response): Promise<void> {
  const id = uuidSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const link = await getProjectGitHubLink(id.data);
  if (!link) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(link);
}

export async function unlinkProjectGithubController(req: Request, res: Response): Promise<void> {
  const id = uuidSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  await unlinkProjectRepository(id.data);
  res.json({ unlinked: true });
}
