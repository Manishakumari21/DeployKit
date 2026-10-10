

import type { Request, Response } from "express";
import { z } from "zod";
import {
  createBootstrapUser,
  createUser,
  findUserByEmail,
  findUserById,
  hasAnyUsers,
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

    const open = isPublicRegistrationEnabled() || !(await hasAnyUsers());
    if (!open) {
      res.status(403).json({ error: "Public registration is disabled" });
      return;
    }
    try {

      const user = isPublicRegistrationEnabled()
        ? await createUser({ email, password: parsed.data.password })
        : await createBootstrapUser({ email, password: parsed.data.password });
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

export async function sessionController(req: Request, res: Response): Promise<void> {
  try {
    const session = await resolveSession(parseSessionCookie(req));
    if (!session) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const row = await findUserById(session.userId);
    if (!row) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    res.json({ user: toPublicUser(row) });
  } catch (error) {
    console.error("Session lookup error");
    res.status(500).json({ error: "Session lookup failed" });
  }
}
