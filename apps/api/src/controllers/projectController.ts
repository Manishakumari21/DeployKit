import { Request, Response } from "express";
import {
  createProject,
  getProjects,
  getProjectById,
  deleteProject,
} from "../services/projectService.js";

export async function createProjectController(
  req: Request,
  res: Response
) {
  try {
    const { name, repositoryUrl, branch } = req.body;

    if (
  typeof name !== "string" ||
  name.trim().length === 0 ||
  name.trim().length > 100
) {
  return res.status(400).json({
    error: "name must be between 1 and 100 characters",
  });
}

if (
  typeof repositoryUrl !== "string" ||
  !/^https?:\/\/.+/.test(repositoryUrl)
) {
  return res.status(400).json({
    error: "repositoryUrl must be a valid HTTP or HTTPS URL",
  });
}
    const project = await createProject({
      name,
      repositoryUrl,
      branch: branch || "main",
    });

    return res.status(201).json(project);
  } catch (error) {
    console.error("Create project error:", error);

    return res.status(500).json({
      error: "Failed to create project",
    });
  }
}

export async function getProjectsController(
  _req: Request,
  res: Response
) {
  try {
    const projects = await getProjects();

    return res.json(projects);
  } catch (error) {
    console.error("Get projects error:", error);

    return res.status(500).json({
      error: "Failed to fetch projects",
    });
  }
}

export async function getProjectController(
  req: Request,
  res: Response
) {
  try {
    const project = await getProjectById(String(req.params.id));

    if (!project) {
      return res.status(404).json({
        error: "Project not found",
      });
    }

    return res.json(project);
  } catch (error) {
    console.error("Get project error:", error);

    return res.status(500).json({
      error: "Failed to fetch project",
    });
  }
}

export async function deleteProjectController(
  req: Request,
  res: Response
) {
  try {
    const project = await deleteProject(String(req.params.id));

    if (!project) {
      return res.status(404).json({
        error: "Project not found",
      });
    }

    return res.json({
      message: "Project deleted successfully",
    });
  } catch (error) {
    console.error("Delete project error:", error);

    return res.status(500).json({
      error: "Failed to delete project",
    });
  }
}