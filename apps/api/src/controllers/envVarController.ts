import { Request, Response } from "express";
import { redactForLog } from "../agents/edgeJobSchema.js";
import { uuidParam } from "./http.js";
import {
  getProjectEnvVars,
  createProjectEnvVar,
  updateProjectEnvVar,
  deleteProjectEnvVar,
  revealProjectEnvVar,
  EnvVarError,
} from "../services/envVarService.js";

export interface EnvVarControllerDeps {
  getProjectEnvVars?: typeof getProjectEnvVars;
  createProjectEnvVar?: typeof createProjectEnvVar;
  updateProjectEnvVar?: typeof updateProjectEnvVar;
  deleteProjectEnvVar?: typeof deleteProjectEnvVar;
  revealProjectEnvVar?: typeof revealProjectEnvVar;
}

export function createEnvVarControllers(deps: EnvVarControllerDeps = {}) {
  const getVars = deps.getProjectEnvVars ?? getProjectEnvVars;
  const createVar = deps.createProjectEnvVar ?? createProjectEnvVar;
  const updateVar = deps.updateProjectEnvVar ?? updateProjectEnvVar;
  const deleteVar = deps.deleteProjectEnvVar ?? deleteProjectEnvVar;
  const revealVar = deps.revealProjectEnvVar ?? revealProjectEnvVar;

  return {
    listEnvVarsController: async (req: Request, res: Response) => {
      try {
        const projectId = uuidParam(req, res, "Invalid project id", "id", "INVALID_ID");
        if (!projectId) return;
        const envVars = await getVars(projectId);
        return res.json(envVars);
      } catch (error) {
        if (error instanceof EnvVarError) {
          return res.status(error.status).json({ error: error.message, code: error.code });
        }
        console.error("List env vars error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
        return res.status(500).json({ error: "Failed to list environment variables" });
      }
    },

    createEnvVarController: async (req: Request, res: Response) => {
      try {
        const projectId = uuidParam(req, res, "Invalid project id", "id", "INVALID_ID");
        if (!projectId) return;
        const { key, value, isSecret } = req.body ?? {};

        if (typeof key !== "string" || !key.trim()) {
          return res.status(400).json({ error: "key is required" });
        }
        if (typeof value !== "string") {
          return res.status(400).json({ error: "value is required" });
        }

        const created = await createVar(projectId, {
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
    },

    updateEnvVarController: async (req: Request, res: Response) => {
      try {
        const projectId = uuidParam(req, res, "Invalid project id", "id", "INVALID_ID");
        if (!projectId) return;
        const varId = uuidParam(req, res, "Invalid environment variable id", "varId", "INVALID_ID");
        if (!varId) return;
        const { key, value, isSecret } = req.body ?? {};

        if (key === undefined && value === undefined && isSecret === undefined) {
          return res.status(400).json({ error: "At least one field (key, value, isSecret) must be provided" });
        }

        const updated = await updateVar(projectId, varId, {
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
    },

    deleteEnvVarController: async (req: Request, res: Response) => {
      try {
        const projectId = uuidParam(req, res, "Invalid project id", "id", "INVALID_ID");
        if (!projectId) return;
        const varId = uuidParam(req, res, "Invalid environment variable id", "varId", "INVALID_ID");
        if (!varId) return;

        const deleted = await deleteVar(projectId, varId);
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
    },

    revealEnvVarController: async (req: Request, res: Response) => {
      try {
        const projectId = uuidParam(req, res, "Invalid project id", "id", "INVALID_ID");
        if (!projectId) return;
        const varId = uuidParam(req, res, "Invalid environment variable id", "varId", "INVALID_ID");
        if (!varId) return;

        const revealed = await revealVar(projectId, varId);
        return res.json(revealed);
      } catch (error) {
        if (error instanceof EnvVarError) {
          return res.status(error.status).json({ error: error.message, code: error.code });
        }
        console.error("Reveal env var error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
        return res.status(500).json({ error: "Failed to reveal environment variable" });
      }
    },
  };
}

export const {
  listEnvVarsController,
  createEnvVarController,
  updateEnvVarController,
  deleteEnvVarController,
  revealEnvVarController,
} = createEnvVarControllers();
