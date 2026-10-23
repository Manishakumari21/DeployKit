import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import {
  getGitHubConnectionController,
  githubCallbackController,
  listGitHubRepositoriesController,
} from "../controllers/githubConnectionController.js";

const router = Router();

router.get("/callback", githubCallbackController);
router.get("/connection", authenticate, getGitHubConnectionController);
router.get("/repositories", authenticate, listGitHubRepositoriesController);

export default router;
