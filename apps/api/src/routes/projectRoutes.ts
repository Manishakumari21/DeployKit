import { Router } from "express";

import {
  createProjectController,
  getProjectsController,
  getProjectController,
  updateProjectController,
  deleteProjectController,
} from "../controllers/projectController.js";
import {
  listEnvVarsController,
  createEnvVarController,
  updateEnvVarController,
  deleteEnvVarController,
  revealEnvVarController,
} from "../controllers/envVarController.js";
import {
  linkProjectGithubController,
  getProjectGithubLinkController,
  unlinkProjectGithubController,
} from "../controllers/githubLinkController.js";
import {
  deleteBuildConfigController,
  detectProjectController,
  getBuildConfigController,
  putBuildConfigController,
} from "../controllers/buildConfigController.js";
import { getProjectEventsController } from "../controllers/projectEventController.js";
import {
  acknowledgeIncidentController,
  getIncidentController,
  listIncidentsController,
  resolveIncidentController,
} from "../controllers/incidentController.js";
import {
  listProjectAgentsController,
  enrollProjectAgentController,
  revokeProjectAgentController,
} from "../controllers/projectAgentController.js";
import {
  authenticate,
  requireProjectAccess,
} from "../middleware/auth.js";
import { requireTrustedOrigin } from "../middleware/origin.js";

const router = Router();

router.use(requireTrustedOrigin);

router.post("/", authenticate, createProjectController);
router.get("/", authenticate, getProjectsController);

router.get("/:id", requireProjectAccess, getProjectController);
router.patch("/:id", requireProjectAccess, updateProjectController);
router.delete("/:id", requireProjectAccess, deleteProjectController);
router.get("/:id/events", requireProjectAccess, getProjectEventsController);

router.get("/:id/env-vars", requireProjectAccess, listEnvVarsController);
router.post("/:id/env-vars", requireProjectAccess, createEnvVarController);
router.get("/:id/env-vars/:varId/reveal", requireProjectAccess, revealEnvVarController);
router.patch("/:id/env-vars/:varId", requireProjectAccess, updateEnvVarController);
router.delete("/:id/env-vars/:varId", requireProjectAccess, deleteEnvVarController);

router.get("/:id/incidents", requireProjectAccess, listIncidentsController);
router.get(
  "/:id/incidents/:incidentId",
  requireProjectAccess,
  getIncidentController
);
router.post(
  "/:id/incidents/:incidentId/acknowledge",
  requireProjectAccess,
  acknowledgeIncidentController
);
router.post(
  "/:id/incidents/:incidentId/resolve",
  requireProjectAccess,
  resolveIncidentController
);

router.get("/:id/build-config", requireProjectAccess, getBuildConfigController);
router.put("/:id/build-config", requireProjectAccess, putBuildConfigController);
router.delete("/:id/build-config", requireProjectAccess, deleteBuildConfigController);
router.post("/:id/detect", requireProjectAccess, detectProjectController);

router.post("/:id/github-link", requireProjectAccess, linkProjectGithubController);
router.get("/:id/github-link", requireProjectAccess, getProjectGithubLinkController);
router.delete("/:id/github-link", requireProjectAccess, unlinkProjectGithubController);

router.get("/:id/agents", requireProjectAccess, listProjectAgentsController);
router.post("/:id/agents", requireProjectAccess, enrollProjectAgentController);
router.delete("/:id/agents/:agentId", requireProjectAccess, revokeProjectAgentController);

export default router;
