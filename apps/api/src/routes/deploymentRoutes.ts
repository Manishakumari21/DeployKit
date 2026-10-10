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
import {
  requireDeploymentRouteAccess,
  requireProjectAccess,
  requireReleaseRouteAccess,
} from "../middleware/auth.js";
import { requireTrustedOrigin } from "../middleware/origin.js";

const router = Router();

router.use(requireTrustedOrigin);

router.post(
  "/projects/:id/deployments",
  requireProjectAccess,
  createDeploymentController
);

router.get(
  "/projects/:id/deployments",
  requireProjectAccess,
  getProjectDeploymentsController
);

router.post(
  "/projects/:id/rollback",
  requireProjectAccess,
  rollbackDeploymentController
);

router.get(
  "/projects/:id/releases",
  requireProjectAccess,
  getProjectReleasesController
);

router.get(
  "/projects/:id/metrics",
  requireProjectAccess,
  getProjectMetricsController
);

router.get(
  "/deployments/:id",
  requireDeploymentRouteAccess,
  getDeploymentController
);

router.get(
  "/deployments/:id/events",
  requireDeploymentRouteAccess,
  getDeploymentEventsController
);

router.get(
  "/deployments/:id/logs",
  requireDeploymentRouteAccess,
  getDeploymentLogsController
);

router.post(
  "/deployments/:id/cancel",
  requireDeploymentRouteAccess,
  cancelDeploymentController
);

router.get(
  "/releases/:id",
  requireReleaseRouteAccess,
  getReleaseController
);

export default router;
