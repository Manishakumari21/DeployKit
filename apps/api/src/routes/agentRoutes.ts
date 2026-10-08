import { Router } from "express";
import {
  completeAgentJobController,
  failAgentJobController,
  getAgentMeController,
  heartbeatAgentJobController,
  claimAgentJobController,
  postAgentHeartbeatController,
} from "../controllers/agentController.js";
import { authenticateAgent } from "../middleware/agentAuth.js";

const router = Router();

router.use(authenticateAgent);

router.get("/me", getAgentMeController);
router.post("/heartbeat", postAgentHeartbeatController);

router.post("/jobs/claim", claimAgentJobController);
router.post("/jobs/:jobId/heartbeat", heartbeatAgentJobController);
router.post("/jobs/:jobId/complete", completeAgentJobController);
router.post("/jobs/:jobId/fail", failAgentJobController);

export default router;
