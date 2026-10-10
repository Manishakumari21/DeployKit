import { Router } from "express";
import {
  loginController,
  logoutController,
  registerController,
  sessionController,
} from "../controllers/authController.js";
import { requireTrustedOrigin } from "../middleware/origin.js";

const router = Router();

router.post("/login", requireTrustedOrigin, loginController);
router.post("/register", requireTrustedOrigin, registerController);
router.post("/logout", requireTrustedOrigin, logoutController);
router.get("/session", sessionController);

export default router;
