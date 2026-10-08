import type { NextFunction, Request, Response } from "express";
import {
  authenticateAgentToken,
  type AgentCredentialResolver,
  type AgentRequestContext,
} from "../agents/agentAuthentication.js";

declare global {
  namespace Express {
    interface Request {
      agent?: AgentRequestContext;
    }
  }
}

export function createAgentAuthMiddleware(
  resolve?: AgentCredentialResolver
) {
  return async function authenticateAgent(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const context = await authenticateAgentToken(
        req.headers.authorization,
        resolve
      );
      if (!context) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      req.agent = context;
      next();
    } catch {
      console.error("Agent authentication error");
      res.status(500).json({ error: "Authentication failed" });
    }
  };
}

export const authenticateAgent = createAgentAuthMiddleware();
