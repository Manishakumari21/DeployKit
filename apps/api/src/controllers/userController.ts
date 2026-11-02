import type { Request, Response } from "express";
import { z } from "zod";
import {
  listUsers,
  setUserDisabled,
  UserError,
} from "../services/userService.js";
import {
  createInvite,
  listInvites,
  revokeInvite,
  InviteError,
} from "../services/inviteService.js";
import { resolveClientIp } from "../config/clientIp.js";
import { checkAuthRateLimit, RateLimitError } from "../services/rateLimitService.js";

function actingAdminId(req: Request): string {
  return req.auth?.userId ?? "";
}

function clientIp(req: Request): string {
  return resolveClientIp({
    socketAddress: req.socket?.remoteAddress ?? req.ip,
    forwardedFor: req.headers["x-forwarded-for"],
  });
}

export async function listUsersController(_req: Request, res: Response): Promise<void> {
  try {
    const users = await listUsers();
    res.json({ users });
  } catch (error) {
    console.error("List users error");
    res.status(500).json({ error: "Could not list users" });
  }
}

const patchUserSchema = z.object({
  disabled: z.boolean(),
});

export async function updateUserController(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const parsed = patchUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  try {
    const user = await setUserDisabled(id, parsed.data.disabled, actingAdminId(req));
    res.json({ user });
  } catch (error) {
    if (error instanceof UserError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    console.error("Update user error");
    res.status(500).json({ error: "Could not update user" });
  }
}

const createInviteSchema = z.object({
  email: z.string().min(3).max(254),
});

export async function createInviteController(req: Request, res: Response): Promise<void> {
  const parsed = createInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid invite request" });
    return;
  }
  try {
    try {
      // Invites mint a live credential, so they are rate-limited per admin IP.
      await checkAuthRateLimit({ kind: "register", ip: clientIp(req), email: parsed.data.email });
    } catch (error) {
      if (error instanceof RateLimitError) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
        res.status(error.status).json({ error: "Too many attempts" });
        return;
      }
      throw error;
    }
    const { invite, token } = await createInvite(parsed.data.email, actingAdminId(req));
    // The raw token is returned exactly once here; only its hash is stored.
    res.status(201).json({ invite, token });
  } catch (error) {
    if (error instanceof InviteError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    if (error instanceof UserError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    console.error("Create invite error");
    res.status(500).json({ error: "Could not create invite" });
  }
}

export async function listInvitesController(_req: Request, res: Response): Promise<void> {
  try {
    const invites = await listInvites();
    res.json({ invites });
  } catch (error) {
    console.error("List invites error");
    res.status(500).json({ error: "Could not list invites" });
  }
}

export async function revokeInviteController(req: Request, res: Response): Promise<void> {
  try {
    const invite = await revokeInvite(String(req.params.id));
    res.json({ invite });
  } catch (error) {
    if (error instanceof InviteError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    console.error("Revoke invite error");
    res.status(500).json({ error: "Could not revoke invite" });
  }
}
