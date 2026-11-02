import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { requireTrustedOrigin } from "../middleware/origin.js";
import {
  createInviteController,
  listInvitesController,
  listUsersController,
  revokeInviteController,
  updateUserController,
} from "../controllers/userController.js";

const router = Router();

router.use(requireTrustedOrigin);

router.get("/users", requireAdmin, listUsersController);
router.patch("/users/:id", requireAdmin, updateUserController);

router.get("/invites", requireAdmin, listInvitesController);
router.post("/invites", requireAdmin, createInviteController);
router.delete("/invites/:id", requireAdmin, revokeInviteController);

export default router;
