import { Router } from "express";

import {
  createProjectController,
  getProjectsController,
  getProjectController,
  deleteProjectController,
} from "../controllers/projectController.js";
import {
  linkProjectGithubController,
  getProjectGithubLinkController,
  unlinkProjectGithubController,
} from "../controllers/githubLinkController.js";
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
router.delete("/:id", requireProjectAccess, deleteProjectController);

router.post("/:id/github-link", requireProjectAccess, linkProjectGithubController);
router.get("/:id/github-link", requireProjectAccess, getProjectGithubLinkController);
router.delete("/:id/github-link", requireProjectAccess, unlinkProjectGithubController);

export default router;
