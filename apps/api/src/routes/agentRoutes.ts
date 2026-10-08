import { Router } from "express";
import {
  getAgentMeController,
  postAgentHeartbeatController,
} from "../controllers/agentController.js";
import { authenticateAgent } from "../middleware/agentAuth.js";

const router = Router();

router.use(authenticateAgent);

router.get("/me", getAgentMeController);
router.post("/heartbeat", postAgentHeartbeatController);

export default router;
