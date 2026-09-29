import { Router } from "express";
import {
  createDeploymentController,
  getDeploymentController,
  getProjectDeploymentsController,
} from "../controllers/deploymentController.js";

const router = Router();

router.post(
  "/projects/:id/deployments",
  createDeploymentController
);

router.get(
  "/projects/:id/deployments",
  getProjectDeploymentsController
);

router.get(
  "/deployments/:id",
  getDeploymentController
);

export default router;
