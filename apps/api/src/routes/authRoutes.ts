import { Router } from "express";
import {
  loginController,
  logoutController,
  registerController,
  sessionController,
} from "../controllers/authController.js";
import { requireTrustedOrigin } from "../middleware/origin.js";

const router = Router();

// All auth mutations are browser-reachable state changers, so they pass the
// origin check. The session probe is a safe GET and skips it internally.
router.post("/login", requireTrustedOrigin, loginController);
router.post("/register", requireTrustedOrigin, registerController);
router.post("/logout", requireTrustedOrigin, logoutController);
router.get("/session", sessionController);

export default router;
