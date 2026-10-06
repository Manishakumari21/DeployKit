// CSRF boundary for the session cookie (deploykit_session).
//
// Reasoning: HttpOnly keeps the token out of JS but does nothing against
// cross-site requests, which is why the cookie is SameSite=Lax (blocks
// cross-site POST/DELETE from modern browsers) AND unsafe methods additionally
// require a trusted Origin/Referer here. The residual accepted case — neither
// header present — is a non-browser client (curl, CI, workers), which cannot
// ride a victim's ambient cookie. Same-origin dashboard traffic (nginx /api
// proxy in prod, vite proxy in dev) always carries Origin on unsafe methods,
// so legitimate browser flows pass.
//
// Explicitly out of scope: POST /api/webhooks/github (GitHub HMAC machine
// auth, no session) and safe methods (GET/HEAD/OPTIONS). No CSRF tokens or
// framework: one cookie, one check, one allowlist shared with CORS.

import type { NextFunction, Request, Response } from "express";
import { getAllowedOrigins } from "../config/corsConfig.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function originOfReferer(referer: string): string | null {
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

// 403 when a browser-issued unsafe request comes from elsewhere. Never logs
// secrets; the Origin header is not sensitive and is safe to log.
export function requireTrustedOrigin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const allowed = new Set(getAllowedOrigins());
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    if (allowed.has(origin)) {
      next();
      return;
    }
    console.error("Untrusted request origin");
    res.status(403).json({ error: "Untrusted origin" });
    return;
  }
  const referer = req.headers.referer ?? req.headers.referrer;
  if (typeof referer === "string" && referer !== "") {
    const refererOrigin = originOfReferer(referer);
    if (refererOrigin && allowed.has(refererOrigin)) {
      next();
      return;
    }
    console.error("Untrusted request origin");
    res.status(403).json({ error: "Untrusted origin" });
    return;
  }
  next();
}
