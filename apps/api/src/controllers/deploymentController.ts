import { Request, Response } from "express";
import { z } from "zod";
import {
  createDeployment,
  getDeploymentById,
  getProjectDeployments,
} from "../services/deploymentService.js";

const uuidSchema = z.string().uuid();

const triggerSchema = z.enum([
  "manual",
  "github_push",
  "rollback",
]);

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

    const rawIdempotencyKey = req.header("Idempotency-Key");
    const idempotencyKey = rawIdempotencyKey?.trim() || null;

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
