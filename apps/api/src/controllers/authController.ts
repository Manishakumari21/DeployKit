

import type { Request, Response } from "express";
import { z } from "zod";
import {
  createBootstrapUser,
  createUser,
  findUserByEmail,
  findUserById,
  hasAnyUsers,
  isDisabled,
  toPublicUser,
  UserError,
  verifyPassword,
} from "../services/userService.js";
import { createSession, resolveSession, revokeSession } from "../services/sessionService.js";
import {
  checkAuthRateLimit,
  clearEmailRateLimit,
  RateLimitError,
} from "../services/rateLimitService.js";
import { isPublicRegistrationEnabled } from "../config/sessionConfig.js";
import { resolveClientIp } from "../config/clientIp.js";
import { InviteError, redeemInvite } from "../services/inviteService.js";
import {
  clearSessionCookie,
  parseSessionCookie,
  setSessionCookie,
} from "../middleware/auth.js";

const DUMMY_HASH =
  "$2b$12$b0bI3z4B9vLtKXCmTH1UNukIcZf0Px7Ei5jc9Mwr59rGFsHJAg2Wi";

const loginSchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(72),
});

const registerSchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(12, "Password must be at least 12 characters").max(72, "Password must be at most 72 characters"),
  inviteToken: z.string().min(1).max(128).optional(),
});

function clientIp(req: Request): string {

  return resolveClientIp({
    socketAddress: req.socket?.remoteAddress ?? req.ip,
    forwardedFor: req.headers["x-forwarded-for"],
  });
}

function rateLimited(res: Response, error: RateLimitError): void {
  res.setHeader("Retry-After", String(error.retryAfterSeconds));
  res.status(error.status).json({ error: "Too many attempts" });
}

export async function loginController(req: Request, res: Response): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid login request" });
    return;
  }
  try {
    try {
      await checkAuthRateLimit({
        kind: "login",
        ip: clientIp(req),
        email: parsed.data.email.trim().toLowerCase(),
      });
    } catch (error) {
      if (error instanceof RateLimitError) {
        rateLimited(res, error);
        return;
      }
      throw error;
    }
    const row = await findUserByEmail(parsed.data.email);
    const ok = row
      ? await verifyPassword(parsed.data.password, row.password_hash)
      : await verifyPassword(parsed.data.password, DUMMY_HASH);
    if (!row || !ok) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    // Disabled accounts must not be able to establish a new session; the
    // message is identical to a bad password to avoid confirming existence.
    if (isDisabled(row)) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    await clearEmailRateLimit("login", row.email);
    const session = await createSession(row.id);
    setSessionCookie(res, session.token);
    res.json(toPublicUser(row));
  } catch (error) {
    console.error("Login error");
    res.status(500).json({ error: "Login failed" });
  }
}

export async function logoutController(req: Request, res: Response): Promise<void> {
  try {
    await revokeSession(parseSessionCookie(req));
  } catch (error) {
    console.error("Logout revocation error");
  }
  clearSessionCookie(res);
  res.json({ loggedOut: true });
}

export async function registerController(req: Request, res: Response): Promise<void> {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((i) => i.path[0] === "password");
    res.status(400).json({ error: issue ? issue.message : "Invalid registration request" });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  try {
    try {
      await checkAuthRateLimit({ kind: "register", ip: clientIp(req), email });
    } catch (error) {
      if (error instanceof RateLimitError) {
        rateLimited(res, error);
        return;
      }
      throw error;
    }

    const hasUsers = await hasAnyUsers();
    if (!hasUsers) {
      // Fresh server: the very first account self-registers as admin.
      const user = await createBootstrapUser({ email, password: parsed.data.password });
      await clearEmailRateLimit("register", email);
      res.status(201).json(user);
      return;
    }

    // Invite-only afterwards: an open signup path must not exist, so a valid
    // invite token is required unless the operator explicitly opts into public
    // registration.
    if (!isPublicRegistrationEnabled()) {
      if (!parsed.data.inviteToken) {
        res.status(403).json({ error: "An invite is required to register" });
        return;
      }
      try {
        const user = await redeemInvite({
          token: parsed.data.inviteToken,
          email,
          password: parsed.data.password,
        });
        await clearEmailRateLimit("register", email);
        res.status(201).json(user);
      } catch (error) {
        if (error instanceof InviteError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        if (error instanceof UserError) {
          const message =
            error.code === "WEAK_PASSWORD"
              ? "Password must be 12–72 characters."
              : error.message;
          res.status(error.status).json({ error: message });
          return;
        }
        throw error;
      }
      return;
    }

    try {
      const user = await createUser({ email, password: parsed.data.password });
      await clearEmailRateLimit("register", email);
      res.status(201).json(user);
    } catch (error) {
      if (error instanceof UserError) {

        const message =
          error.code === "WEAK_PASSWORD"
            ? "Password must be 12–72 characters."
            : error.message;
        res.status(error.status).json({ error: message });
        return;
      }
      throw error;
    }
  } catch (error) {
    console.error("Registration error");
    res.status(500).json({ error: "Registration failed" });
  }
}

// Lets the login screen render the correct mode (invite-only vs open) instead
// of only discovering it after a failed submit.
export async function registrationStatusController(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const hasUsers = await hasAnyUsers();
    const mode = !hasUsers
      ? "bootstrap"
      : isPublicRegistrationEnabled()
        ? "public"
        : "invite";
    res.json({ hasUsers, mode });
  } catch (error) {
    console.error("Registration status error");
    res.status(500).json({ error: "Registration status unavailable" });
  }
}

export async function sessionController(req: Request, res: Response): Promise<void> {
  try {
    const session = await resolveSession(parseSessionCookie(req));
    if (!session) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const row = await findUserById(session.userId);
    if (!row || isDisabled(row)) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    res.json({ user: toPublicUser(row) });
  } catch (error) {
    console.error("Session lookup error");
    res.status(500).json({ error: "Session lookup failed" });
  }
}
