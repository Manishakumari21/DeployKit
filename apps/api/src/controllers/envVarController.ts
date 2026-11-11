import { Request, Response } from "express";
import { redactForLog } from "../agents/edgeJobSchema.js";
import {
  getProjectEnvVars,
  createProjectEnvVar,
  updateProjectEnvVar,
  deleteProjectEnvVar,
  revealProjectEnvVar,
  EnvVarError,
} from "../services/envVarService.js";

export async function listEnvVarsController(req: Request, res: Response) {
  try {
    const projectId = String(req.params.id);
    const envVars = await getProjectEnvVars(projectId);
    return res.json(envVars);
  } catch (error) {
    if (error instanceof EnvVarError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("List env vars error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
    return res.status(500).json({ error: "Failed to list environment variables" });
  }
}

export async function createEnvVarController(req: Request, res: Response) {
  try {
    const projectId = String(req.params.id);
    const { key, value, isSecret } = req.body ?? {};

    if (typeof key !== "string" || !key.trim()) {
      return res.status(400).json({ error: "key is required" });
    }
    if (typeof value !== "string") {
      return res.status(400).json({ error: "value is required" });
    }

    const created = await createProjectEnvVar(projectId, {
      key,
      value,
      isSecret: Boolean(isSecret),
    });

    return res.status(201).json(created);
  } catch (error) {
    if (error instanceof EnvVarError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("Create env var error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
    return res.status(500).json({ error: "Failed to create environment variable" });
  }
}

export async function updateEnvVarController(req: Request, res: Response) {
  try {
    const projectId = String(req.params.id);
    const varId = String(req.params.varId);
    const { key, value, isSecret } = req.body ?? {};

    if (key === undefined && value === undefined && isSecret === undefined) {
      return res.status(400).json({ error: "At least one field (key, value, isSecret) must be provided" });
    }

    const updated = await updateProjectEnvVar(projectId, varId, {
      key,
      value,
      isSecret,
    });

    return res.json(updated);
  } catch (error) {
    if (error instanceof EnvVarError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("Update env var error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
    return res.status(500).json({ error: "Failed to update environment variable" });
  }
}

export async function deleteEnvVarController(req: Request, res: Response) {
  try {
    const projectId = String(req.params.id);
    const varId = String(req.params.varId);

    const deleted = await deleteProjectEnvVar(projectId, varId);
    if (!deleted) {
      return res.status(404).json({ error: "Environment variable not found" });
    }

    return res.json({ message: "Environment variable deleted successfully" });
  } catch (error) {
    if (error instanceof EnvVarError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("Delete env var error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
    return res.status(500).json({ error: "Failed to delete environment variable" });
  }
}

export async function revealEnvVarController(req: Request, res: Response) {
  try {
    const projectId = String(req.params.id);
    const varId = String(req.params.varId);

    const revealed = await revealProjectEnvVar(projectId, varId);
    return res.json(revealed);
  } catch (error) {
    if (error instanceof EnvVarError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("Reveal env var error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
    return res.status(500).json({ error: "Failed to reveal environment variable" });
  }
}
