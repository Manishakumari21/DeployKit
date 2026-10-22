import type { Request, Response } from "express";

import { SourceCheckoutError } from "../infrastructure/git/sourceCheckout.js";
import {
  BuildConfigError,
  clearProjectBuildConfig,
  getProjectBuildConfig,
  saveProjectBuildConfig,
} from "../services/buildConfigService.js";
import { detectProjectById } from "../services/projectDetectionService.js";
import { fail, uuidParam } from "./http.js";

export interface BuildConfigControllerDeps {
  getConfig?: typeof getProjectBuildConfig;
  saveConfig?: typeof saveProjectBuildConfig;
  clearConfig?: typeof clearProjectBuildConfig;
  detectProject?: typeof detectProjectById;
}

const CLIENT_ERROR_CODES = new Set([
  "INVALID_REPOSITORY_URL",
  "UNSUPPORTED_REPOSITORY_PROTOCOL",
  "REPOSITORY_CREDENTIALS_FORBIDDEN",
  "REPOSITORY_HOST_NOT_ALLOWED",
  "INVALID_BRANCH",
  "INVALID_COMMIT_SHA",
]);

function handleError(res: Response, error: unknown): void {
  if (error instanceof BuildConfigError) {
    fail(res, error.status, error.message);
    return;
  }
  if (error instanceof SourceCheckoutError) {
    const status = CLIENT_ERROR_CODES.has(error.code)
      ? 422
      : error.code === "GIT_TIMEOUT"
        ? 504
        : 502;
    res.status(status).json({
      error: "Repository could not be checked out",
      code: error.code,
    });
    return;
  }
  console.error("Build configuration error");
  fail(res, 500, "Failed to process request");
}

type RouteHandler = (
  projectId: string,
  req: Request,
  res: Response
) => Promise<void>;

export function createBuildConfigControllers(deps: BuildConfigControllerDeps = {}) {
  const getConfig = deps.getConfig ?? getProjectBuildConfig;
  const saveConfig = deps.saveConfig ?? saveProjectBuildConfig;
  const clearConfig = deps.clearConfig ?? clearProjectBuildConfig;
  const detectProject = deps.detectProject ?? detectProjectById;

  const route = (handler: RouteHandler) =>
    async (req: Request, res: Response): Promise<void> => {
      const projectId = uuidParam(req, res);
      if (!projectId) return;
      try {
        await handler(projectId, req, res);
      } catch (error) {
        handleError(res, error);
      }
    };

  return {
    getBuildConfigController: route(async (projectId, _req, res) => {
      const stored = await getConfig(projectId);
      res.json({
        config: stored?.config ?? null,
        updatedAt: stored?.updatedAt ?? null,
      });
    }),

    putBuildConfigController: route(async (projectId, req, res) => {
      const stored = await saveConfig(projectId, req.body);
      res.json({ config: stored.config, updatedAt: stored.updatedAt });
    }),

    deleteBuildConfigController: route(async (projectId, _req, res) => {
      await clearConfig(projectId);
      res.json({ config: null });
    }),

    detectProjectController: route(async (projectId, _req, res) => {
      res.json(await detectProject(projectId));
    }),
  };
}

export const {
  getBuildConfigController,
  putBuildConfigController,
  deleteBuildConfigController,
  detectProjectController,
} = createBuildConfigControllers();
