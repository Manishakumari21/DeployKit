

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
