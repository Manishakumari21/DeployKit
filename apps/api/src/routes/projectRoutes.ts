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

const router = Router();

router.post("/", createProjectController);
router.get("/", getProjectsController);
router.get("/:id", getProjectController);
router.delete("/:id", deleteProjectController);

router.post("/:id/github-link", linkProjectGithubController);
router.get("/:id/github-link", getProjectGithubLinkController);
router.delete("/:id/github-link", unlinkProjectGithubController);

export default router;
