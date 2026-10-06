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

// Browser state changers pass the origin check first (safe methods skip it
// internally); webhooks stay exempt because they never reach this router.
router.use(requireTrustedOrigin);

// Collection routes authenticate only; the controllers scope by identity
// (creation assigns ownership, listing returns member projects).
router.post("/", authenticate, createProjectController);
router.get("/", authenticate, getProjectsController);

// Item routes additionally require project membership (403 when unowned).
router.get("/:id", requireProjectAccess, getProjectController);
router.delete("/:id", requireProjectAccess, deleteProjectController);

router.post("/:id/github-link", requireProjectAccess, linkProjectGithubController);
router.get("/:id/github-link", requireProjectAccess, getProjectGithubLinkController);
router.delete("/:id/github-link", requireProjectAccess, unlinkProjectGithubController);

export default router;
