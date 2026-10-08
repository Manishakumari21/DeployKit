import { Request, Response } from "express";
import {
  AgentError,
  getAgentById,
  updateAgentHeartbeat,
  type Agent,
} from "../agents/agentService.js";

interface SafeAgentView {
  id: string;
  projectId: string;
  name: string;
  status: Agent["status"];
  lastHeartbeatAt: string | null;
  version: string | null;
  createdAt: string;
  updatedAt: string;
}

function toSafeAgentView(agent: Agent): SafeAgentView {
  return {
    id: agent.id,
    projectId: agent.projectId,
    name: agent.name,
    status: agent.status,
    lastHeartbeatAt: agent.lastHeartbeatAt,
    version: agent.version,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function agentContext(req: Request) {
  return req.agent ?? null;
}

export async function getAgentMeController(req: Request, res: Response) {
  try {
    const context = agentContext(req);
    if (!context) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const agent = await getAgentById(context.agentId);
    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }
    return res.status(200).json(toSafeAgentView(agent));
  } catch {
    return res.status(500).json({ error: "Failed to load agent" });
  }
}

export async function postAgentHeartbeatController(
  req: Request,
  res: Response
) {
  try {
    const context = agentContext(req);
    if (!context) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const body =
      typeof req.body === "object" && req.body !== null
        ? (req.body as { version?: unknown })
        : undefined;
    try {
      const agent = await updateAgentHeartbeat(
        context.agentId,
        body?.version as string | undefined
      );
      return res.status(200).json(toSafeAgentView(agent));
    } catch (error) {
      if (error instanceof AgentError) {
        if (error.code === "INVALID_VERSION") {
          return res.status(400).json({ error: "Invalid agent version" });
        }
        if (error.code === "AGENT_REVOKED") {
          return res.status(403).json({ error: "Agent is revoked" });
        }
        if (error.code === "AGENT_NOT_FOUND") {
          return res.status(404).json({ error: "Agent not found" });
        }
      }
      throw error;
    }
  } catch {
    return res.status(500).json({ error: "Failed to record heartbeat" });
  }
}
