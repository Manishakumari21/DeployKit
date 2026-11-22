import { Request, Response } from "express";
import { z } from "zod";
import { uuidParam, UUID_PATTERN } from "./http.js";
import { redactForLog } from "../agents/edgeJobSchema.js";
import { AgentError } from "../agents/agentService.js";
import {
  cancelDeployment as defaultCancelDeployment,
  createDeployment as defaultCreateDeployment,
  DeploymentConflictError,
  getDeploymentById as defaultGetDeploymentById,
  getDeploymentEvents as defaultGetDeploymentEvents,
  getProjectDeployments as defaultGetProjectDeployments,
} from "../services/deploymentService.js";
import {
  getProjectReleases as defaultGetProjectReleases,
  getReleaseById as defaultGetReleaseById,
} from "../services/releaseService.js";
import {
  checkDeploymentRateLimit as defaultCheckDeploymentRateLimit,
  RateLimitError,
} from "../services/rateLimitService.js";

const uuidSchema = z.string().regex(UUID_PATTERN, "Invalid UUID");

const triggerSchema = z.enum([
  "manual",
  "github_push",
  "github_pull_request",
  "rollback",
]);

const paginationQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^[0-9]+$/)
    .transform(Number)
    .refine((n) => n >= 1 && n <= 100, "limit must be between 1 and 100")
    .optional(),
  cursor: z
    .string()
    .regex(UUID_PATTERN, "cursor must be a valid UUID")
    .optional(),
});

const eventPaginationQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^[0-9]+$/)
    .transform(Number)
    .refine((n) => n >= 1 && n <= 200, "limit must be between 1 and 200")
    .optional(),
  cursor: z
    .string()
    .regex(/^[0-9]+$/, "cursor must be a numeric event id")
    .optional(),
});

function idempotencyKeyFrom(req: Request): string | null {
  const raw = req.header("Idempotency-Key");
  const key = raw?.trim() || null;
  return key;
}

export interface DeploymentControllerDeps {
  createDeployment?: typeof defaultCreateDeployment;
  cancelDeployment?: typeof defaultCancelDeployment;
  getDeploymentById?: typeof defaultGetDeploymentById;
  getDeploymentEvents?: typeof defaultGetDeploymentEvents;
  getProjectDeployments?: typeof defaultGetProjectDeployments;
  getProjectReleases?: typeof defaultGetProjectReleases;
  getReleaseById?: typeof defaultGetReleaseById;
  checkDeploymentRateLimit?: typeof defaultCheckDeploymentRateLimit;
}

export function createDeploymentControllers(deps: DeploymentControllerDeps = {}) {
  const createDep = deps.createDeployment ?? defaultCreateDeployment;
  const cancelDep = deps.cancelDeployment ?? defaultCancelDeployment;
  const getDepById = deps.getDeploymentById ?? defaultGetDeploymentById;
  const getDepEvents = deps.getDeploymentEvents ?? defaultGetDeploymentEvents;
  const getProjDeps = deps.getProjectDeployments ?? defaultGetProjectDeployments;
  const getProjReleases = deps.getProjectReleases ?? defaultGetProjectReleases;
  const getRelById = deps.getReleaseById ?? defaultGetReleaseById;
  const checkRateLimit = deps.checkDeploymentRateLimit ?? defaultCheckDeploymentRateLimit;

  return {
    async createDeploymentController(req: Request, res: Response) {
      try {
        const projectIdResult = uuidSchema.safeParse(req.params.id);

        if (!projectIdResult.success) {
          return res.status(400).json({
            error: "Invalid project id",
          });
        }

        const triggerResult = triggerSchema.safeParse(
          req.body?.trigger ?? "manual"
        );

        if (!triggerResult.success) {
          return res.status(400).json({
            error: "Invalid deployment trigger",
          });
        }

        if (triggerResult.data === "rollback") {
          return res.status(400).json({
            error: "Use POST /api/projects/:id/rollback for rollbacks",
          });
        }

        const idempotencyKey = idempotencyKeyFrom(req);

        if (idempotencyKey && idempotencyKey.length > 255) {
          return res.status(400).json({
            error: "Idempotency-Key must be 255 characters or less",
          });
        }

        const rawTarget = req.body?.targetAgentId;
        let targetAgentId: string | null = null;
        if (rawTarget !== undefined && rawTarget !== null) {
          const targetResult = uuidSchema.safeParse(rawTarget);
          if (!targetResult.success) {
            return res.status(400).json({
              error: "Invalid target agent id",
            });
          }
          targetAgentId = targetResult.data;
        }

        try {
          await checkRateLimit({
            projectId: projectIdResult.data,
            userId: (req as Request & { user?: { id?: string } }).user?.id,
            ip: req.ip || "unknown",
          });
        } catch (error) {
          if (error instanceof RateLimitError) {
            res.setHeader("Retry-After", String(error.retryAfterSeconds));
            return res.status(429).json({
              error: error.message,
              code: error.code,
              retryAfterSeconds: error.retryAfterSeconds,
            });
          }
          throw error;
        }

        try {
          const deployment = await createDep({
            projectId: projectIdResult.data,
            trigger: triggerResult.data,
            idempotencyKey,
            targetAgentId,
          });

          if (!deployment) {
            return res.status(404).json({
              error: "Project not found",
            });
          }

          return res.status(201).json(deployment);
        } catch (error) {
          if (error instanceof AgentError) {
            return res.status(error.status).json({ error: error.message });
          }
          if (error instanceof DeploymentConflictError) {
            return res.status(409).json({
              error: error.message,
              activeDeploymentId: error.activeDeploymentId,
            });
          }
          throw error;
        }
      } catch (error) {
        console.error("Create deployment error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");

        return res.status(500).json({
          error: "Failed to create deployment",
        });
      }
    },

    async rollbackDeploymentController(req: Request, res: Response) {
      try {
        const projectIdResult = uuidSchema.safeParse(req.params.id);
        if (!projectIdResult.success) {
          return res.status(400).json({ error: "Invalid project id" });
        }
        const body = z
          .object({ releaseId: uuidSchema })
          .safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid releaseId" });
        }
        const idempotencyKey = idempotencyKeyFrom(req);
        if (idempotencyKey && idempotencyKey.length > 255) {
          return res
            .status(400)
            .json({ error: "Idempotency-Key must be 255 characters or less" });
        }

        try {
          await checkRateLimit({
            projectId: projectIdResult.data,
            userId: (req as Request & { user?: { id?: string } }).user?.id,
            ip: req.ip || "unknown",
          });
        } catch (error) {
          if (error instanceof RateLimitError) {
            res.setHeader("Retry-After", String(error.retryAfterSeconds));
            return res.status(429).json({
              error: error.message,
              code: error.code,
              retryAfterSeconds: error.retryAfterSeconds,
            });
          }
          throw error;
        }

        try {
          const deployment = await createDep({
            projectId: projectIdResult.data,
            trigger: "rollback",
            idempotencyKey,
            rollbackReleaseId: body.data.releaseId,
          });
          if (!deployment) {
            return res.status(404).json({ error: "Project or release not found" });
          }
          return res.status(201).json(deployment);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Rollback failed";
          if (error instanceof DeploymentConflictError) {
            return res.status(409).json({
              error: error.message,
              activeDeploymentId: error.activeDeploymentId,
            });
          }
          if (
            message.includes("failed release") ||
            message.includes("required")
          ) {
            return res.status(400).json({ error: message });
          }
          throw error;
        }
      } catch (error) {
        console.error("Rollback deployment error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
        return res.status(500).json({ error: "Failed to create rollback" });
      }
    },

    async cancelDeploymentController(req: Request, res: Response) {
      try {
        const idResult = uuidSchema.safeParse(req.params.id);
        if (!idResult.success) {
          return res.status(400).json({ error: "Invalid deployment id" });
        }
        try {
          const result = await cancelDep(idResult.data);
          if (!result) {
            return res.status(404).json({ error: "Deployment not found" });
          }
          return res.json(result);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Cancel failed";
          if (message.includes("Cannot cancel")) {
            return res.status(409).json({ error: message });
          }
          throw error;
        }
      } catch (error) {
        console.error("Cancel deployment error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
        return res.status(500).json({ error: "Failed to cancel deployment" });
      }
    },

    async getDeploymentController(req: Request, res: Response) {
      try {
        const id = uuidParam(req, res, "Invalid deployment id");
        if (!id) return;
        const deployment = await getDepById(id);

        if (!deployment) {
          return res.status(404).json({
            error: "Deployment not found",
          });
        }

        return res.json(deployment);
      } catch (error) {
        console.error("Get deployment error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");

        return res.status(500).json({
          error: "Failed to fetch deployment",
        });
      }
    },

    async getProjectDeploymentsController(req: Request, res: Response) {
      try {
        const id = uuidParam(req, res, "Invalid project id");
        if (!id) return;

        const parsedQuery = paginationQuerySchema.safeParse(req.query);
        if (!parsedQuery.success) {
          return res.status(400).json({
            error: "Invalid pagination query parameters",
            code: "INVALID_QUERY",
          });
        }

        const { limit, cursor } = parsedQuery.data;
        const deployments = await getProjDeps(id, { limit, cursor });

        if (limit && deployments.length === limit && deployments.length > 0) {
          const nextCursor = (deployments[deployments.length - 1] as { id?: string })?.id;
          if (nextCursor) {
            res.setHeader("X-Next-Cursor", nextCursor);
          }
        }

        return res.json(deployments);
      } catch (error) {
        console.error("Get project deployments error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");

        return res.status(500).json({
          error: "Failed to fetch deployments",
        });
      }
    },

    async getDeploymentEventsController(req: Request, res: Response) {
      try {
        const id = uuidParam(req, res, "Invalid deployment id");
        if (!id) return;
        const deployment = await getDepById(id);
        if (!deployment) {
          return res.status(404).json({ error: "Deployment not found" });
        }

        const parsedQuery = eventPaginationQuerySchema.safeParse(req.query);
        if (!parsedQuery.success) {
          return res.status(400).json({
            error: "Invalid pagination query parameters",
            code: "INVALID_QUERY",
          });
        }

        const { limit, cursor } = parsedQuery.data;
        const events = await getDepEvents(id, { limit, cursor });

        if (limit && events.length === limit && events.length > 0) {
          const nextCursor = (events[events.length - 1] as { id?: string })?.id;
          if (nextCursor) {
            res.setHeader("X-Next-Cursor", nextCursor);
          }
        }

        return res.json(events);
      } catch (error) {
        console.error("Get deployment events error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
        return res.status(500).json({ error: "Failed to fetch events" });
      }
    },

    async getProjectReleasesController(req: Request, res: Response) {
      try {
        const idResult = uuidSchema.safeParse(req.params.id);
        if (!idResult.success) {
          return res.status(400).json({ error: "Invalid project id" });
        }

        const parsedQuery = paginationQuerySchema.safeParse(req.query);
        if (!parsedQuery.success) {
          return res.status(400).json({
            error: "Invalid pagination query parameters",
            code: "INVALID_QUERY",
          });
        }

        const { limit, cursor } = parsedQuery.data;
        const releases = await getProjReleases(idResult.data, { limit, cursor });

        if (limit && releases.length === limit && releases.length > 0) {
          const nextCursor = (releases[releases.length - 1] as { id?: string })?.id;
          if (nextCursor) {
            res.setHeader("X-Next-Cursor", nextCursor);
          }
        }

        return res.json(releases);
      } catch (error) {
        console.error("Get releases error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
        return res.status(500).json({ error: "Failed to fetch releases" });
      }
    },

    async getReleaseController(req: Request, res: Response) {
      try {
        const idResult = uuidSchema.safeParse(req.params.id);
        if (!idResult.success) {
          return res.status(400).json({ error: "Invalid release id" });
        }
        const release = await getRelById(idResult.data);
        if (!release) {
          return res.status(404).json({ error: "Release not found" });
        }
        return res.json(release);
      } catch (error) {
        console.error("Get release error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
        return res.status(500).json({ error: "Failed to fetch release" });
      }
    },
  };
}

const defaultControllers = createDeploymentControllers();

export const createDeploymentController = defaultControllers.createDeploymentController;
export const rollbackDeploymentController = defaultControllers.rollbackDeploymentController;
export const cancelDeploymentController = defaultControllers.cancelDeploymentController;
export const getDeploymentController = defaultControllers.getDeploymentController;
export const getProjectDeploymentsController = defaultControllers.getProjectDeploymentsController;
export const getDeploymentEventsController = defaultControllers.getDeploymentEventsController;
export const getProjectReleasesController = defaultControllers.getProjectReleasesController;
export const getReleaseController = defaultControllers.getReleaseController;
