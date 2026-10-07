// Phase 10 Step 4: HTTP authentication boundary.
// Resolves the session cookie to an authenticated identity and enforces
// project access via authorizationService. This layer never decides project
// permissions itself; it only supplies the authenticated userId.
// Raw session tokens are never logged here.

import type { NextFunction, Request, Response } from "express";
import {
  SESSION_COOKIE_NAME,
  getSessionLifetimeMs,
  isCookieSecure,
} from "../config/sessionConfig.js";
import { resolveSession } from "../services/sessionService.js";
import {
  AuthorizationError,
  requireDeploymentAccess,
  requireProjectMembership,
  requireReleaseAccess,
} from "../services/authorizationService.js";

export interface AuthContext {
  userId: string;
  sessionId: string;
}

declare global {
  // Set by authenticate(); routes wired with it guarantee presence.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  namespace Express {
    interface Request {
      auth?: AuthContext;
      projectId?: string;
    }
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// No cookie-parser in this repo; parse the single session cookie directly.
// Exact-name match only, so similarly-named cookies cannot confuse lookup.
export function parseSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string" || !header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE_NAME) continue;
    try {
      const value = decodeURIComponent(part.slice(index + 1).trim());
      return value || null;
    } catch {
      return null;
    }
  }
  return null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isCookieSecure(),
    path: "/",
    maxAge: getSessionLifetimeMs(),
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isCookieSecure(),
    path: "/",
  });
}

function unauthorized(res: Response): void {
  res.status(401).json({ error: "Authentication required" });
}

function forbidden(res: Response): void {
  res.status(403).json({ error: "Access denied" });
}

async function authenticateRequest(req: Request): Promise<AuthContext | null> {
  const session = await resolveSession(parseSessionCookie(req));
  if (!session) return null;
  return { userId: session.userId, sessionId: session.sessionId };
}

// 401 when no valid session. Downstream handlers use req.auth.
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      unauthorized(res);
      return;
    }
    req.auth = auth;
    next();
  } catch (error) {
    console.error("Authentication error");
    res.status(500).json({ error: "Authentication failed" });
  }
}

// For routes where :id is the project id. Order: 401, then 400 for malformed
// ids (existing convention), then 403 via the authorization service.
export async function requireProjectAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      unauthorized(res);
      return;
    }
    const projectId = req.params.id;
    if (typeof projectId !== "string" || !UUID_PATTERN.test(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    try {
      await requireProjectMembership({ userId: auth.userId, projectId });
    } catch (error) {
      if (error instanceof AuthorizationError) {
        forbidden(res);
        return;
      }
      throw error;
    }
    req.auth = auth;
    req.projectId = projectId;
    next();
  } catch (error) {
    console.error("Authorization error");
    res.status(500).json({ error: "Authorization failed" });
  }
}

function deploymentParam(req: Request): string | null {
  const id = req.params.id;
  return typeof id === "string" && UUID_PATTERN.test(id) ? id : null;
}

// For routes carrying only a deployment id: resolve the owning project,
// then apply the same membership decision. Unknown ids stay 404.
export async function requireDeploymentRouteAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      unauthorized(res);
      return;
    }
    const deploymentId = deploymentParam(req);
    if (!deploymentId) {
      res.status(400).json({ error: "Invalid deployment id" });
      return;
    }
    let projectId: string;
    try {
      ({ projectId } = await requireDeploymentAccess(auth.userId, deploymentId));
    } catch (error) {
      if (error instanceof AuthorizationError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
    req.auth = auth;
    req.projectId = projectId;
    next();
  } catch (error) {
    console.error("Authorization error");
    res.status(500).json({ error: "Authorization failed" });
  }
}

// Same shape for release ids. Unknown ids stay 404.
export async function requireReleaseRouteAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      unauthorized(res);
      return;
    }
    const releaseId = deploymentParam(req);
    if (!releaseId) {
      res.status(400).json({ error: "Invalid release id" });
      return;
    }
    let projectId: string;
    try {
      ({ projectId } = await requireReleaseAccess(auth.userId, releaseId));
    } catch (error) {
      if (error instanceof AuthorizationError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
    req.auth = auth;
    req.projectId = projectId;
    next();
  } catch (error) {
    console.error("Authorization error");
    res.status(500).json({ error: "Authorization failed" });
  }
}

export async function requireDomainRouteAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      unauthorized(res);
      return;
    }
    const domainId = deploymentParam(req);
    if (!domainId) {
      res.status(400).json({ error: "Invalid domain id" });
      return;
    }
    let projectId: string;
    try {
      const { requireDomainAccess } = await import(
        "../services/authorizationService.js"
      );
      ({ projectId } = await requireDomainAccess(auth.userId, domainId));
    } catch (error) {
      if (error instanceof AuthorizationError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
    req.auth = auth;
    req.projectId = projectId;
    next();
  } catch (error) {
    console.error("Authorization error");
    res.status(500).json({ error: "Authorization failed" });
  }
}
