import { Router } from "express";

import {
  createProjectController,
  getProjectsController,
  getProjectController,
  deleteProjectController,
} from "../controllers/projectController.js";

const router = Router();

router.post("/", createProjectController);
router.get("/", getProjectsController);
router.get("/:id", getProjectController);
router.delete("/:id", deleteProjectController);

export default router;