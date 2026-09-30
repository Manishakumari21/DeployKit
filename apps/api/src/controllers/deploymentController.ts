import { Request, Response } from "express";
import { z } from "zod";
import {
  cancelDeployment,
  createDeployment,
  getDeploymentById,
  getDeploymentEvents,
  getProjectDeployments,
} from "../services/deploymentService.js";
import {
  getProjectReleases,
  getReleaseById,
} from "../services/releaseService.js";

const uuidSchema = z.string().uuid();

const triggerSchema = z.enum([
  "manual",
  "github_push",
  "rollback",
]);

function idempotencyKeyFrom(req: Request): string | null {
  const raw = req.header("Idempotency-Key");
  const key = raw?.trim() || null;
  return key;
}

export async function createDeploymentController(
  req: Request,
  res: Response
) {
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

    const deployment = await createDeployment({
      projectId: projectIdResult.data,
      trigger: triggerResult.data,
      idempotencyKey,
    });

    if (!deployment) {
      return res.status(404).json({
        error: "Project not found",
      });
    }

    return res.status(201).json(deployment);
  } catch (error) {
    console.error("Create deployment error:", error);

    return res.status(500).json({
      error: "Failed to create deployment",
    });
  }
}

export async function rollbackDeploymentController(
  req: Request,
  res: Response
) {
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
      const deployment = await createDeployment({
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
      if (
        message.includes("failed release") ||
        message.includes("required")
      ) {
        return res.status(400).json({ error: message });
      }
      throw error;
    }
  } catch (error) {
    console.error("Rollback deployment error:", error);
    return res.status(500).json({ error: "Failed to create rollback" });
  }
}

export async function cancelDeploymentController(
  req: Request,
  res: Response
) {
  try {
    const idResult = uuidSchema.safeParse(req.params.id);
    if (!idResult.success) {
      return res.status(400).json({ error: "Invalid deployment id" });
    }
    try {
      const result = await cancelDeployment(idResult.data);
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
    console.error("Cancel deployment error:", error);
    return res.status(500).json({ error: "Failed to cancel deployment" });
  }
}

export async function getDeploymentController(
  req: Request,
  res: Response
) {
  try {
    const deploymentIdResult = uuidSchema.safeParse(req.params.id);

    if (!deploymentIdResult.success) {
      return res.status(400).json({
        error: "Invalid deployment id",
      });
    }

    const deployment = await getDeploymentById(
      deploymentIdResult.data
    );

    if (!deployment) {
      return res.status(404).json({
        error: "Deployment not found",
      });
    }

    return res.json(deployment);
  } catch (error) {
    console.error("Get deployment error:", error);

    return res.status(500).json({
      error: "Failed to fetch deployment",
    });
  }
}

export async function getProjectDeploymentsController(
  req: Request,
  res: Response
) {
  try {
    const projectIdResult = uuidSchema.safeParse(req.params.id);

    if (!projectIdResult.success) {
      return res.status(400).json({
        error: "Invalid project id",
      });
    }

    const deployments = await getProjectDeployments(
      projectIdResult.data
    );

    return res.json(deployments);
  } catch (error) {
    console.error("Get project deployments error:", error);

    return res.status(500).json({
      error: "Failed to fetch deployments",
    });
  }
}

export async function getDeploymentEventsController(
  req: Request,
  res: Response
) {
  try {
    const idResult = uuidSchema.safeParse(req.params.id);
    if (!idResult.success) {
      return res.status(400).json({ error: "Invalid deployment id" });
    }
    const deployment = await getDeploymentById(idResult.data);
    if (!deployment) {
      return res.status(404).json({ error: "Deployment not found" });
    }
    const events = await getDeploymentEvents(idResult.data);
    return res.json(events);
  } catch (error) {
    console.error("Get deployment events error:", error);
    return res.status(500).json({ error: "Failed to fetch events" });
  }
}

export async function getProjectReleasesController(
  req: Request,
  res: Response
) {
  try {
    const idResult = uuidSchema.safeParse(req.params.id);
    if (!idResult.success) {
      return res.status(400).json({ error: "Invalid project id" });
    }
    const releases = await getProjectReleases(idResult.data);
    return res.json(releases);
  } catch (error) {
    console.error("Get releases error:", error);
    return res.status(500).json({ error: "Failed to fetch releases" });
  }
}

export async function getReleaseController(
  req: Request,
  res: Response
) {
  try {
    const idResult = uuidSchema.safeParse(req.params.id);
    if (!idResult.success) {
      return res.status(400).json({ error: "Invalid release id" });
    }
    const release = await getReleaseById(idResult.data);
    if (!release) {
      return res.status(404).json({ error: "Release not found" });
    }
    return res.json(release);
  } catch (error) {
    console.error("Get release error:", error);
    return res.status(500).json({ error: "Failed to fetch release" });
  }
}
