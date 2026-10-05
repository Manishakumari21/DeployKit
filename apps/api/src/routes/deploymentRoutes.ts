import { Router } from "express";
import {
  cancelDeploymentController,
  createDeploymentController,
  getDeploymentController,
  getDeploymentEventsController,
  getProjectDeploymentsController,
  getProjectReleasesController,
  getReleaseController,
  rollbackDeploymentController,
} from "../controllers/deploymentController.js";

import { getDeploymentLogsController } from "../controllers/logController.js";
import { getProjectMetricsController } from "../controllers/metricsController.js";

const router = Router();

router.post(
  "/projects/:id/deployments",
  createDeploymentController
);

router.get(
  "/projects/:id/deployments",
  getProjectDeploymentsController
);

router.post(
  "/projects/:id/rollback",
  rollbackDeploymentController
);

router.get(
  "/projects/:id/releases",
  getProjectReleasesController
);

router.get(
  "/deployments/:id",
  getDeploymentController
);

router.get(
  "/deployments/:id/events",
  getDeploymentEventsController
);

router.get(
  "/deployments/:id/logs",
  getDeploymentLogsController
);

router.get(
  "/projects/:id/metrics",
  getProjectMetricsController
);

router.post(
  "/deployments/:id/cancel",
  cancelDeploymentController
);

router.get("/releases/:id", getReleaseController);

export default router;
