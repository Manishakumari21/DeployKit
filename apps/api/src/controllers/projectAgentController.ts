import { Request, Response } from "express";
import {
  listProjectAgents,
  createAgent,
  createEnrollmentCredential,
  revokeAgent,
  getAgentById,
  AgentError,
} from "../agents/agentService.js";
import { redactForLog } from "../agents/edgeJobSchema.js";

export async function listProjectAgentsController(req: Request, res: Response) {
  try {
    const projectId = String(req.params.id);
    const agents = await listProjectAgents(projectId);
    return res.json(agents);
  } catch (error) {
    if (error instanceof AgentError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("List project agents error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
    return res.status(500).json({ error: "Failed to list servers and edge agents" });
  }
}

export async function enrollProjectAgentController(req: Request, res: Response) {
  try {
    const projectId = String(req.params.id);
    const { name, expiresAt } = req.body ?? {};

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Agent/Server name is required", code: "INVALID_NAME" });
    }

    const agent = await createAgent(projectId, name.trim());
    const credential = await createEnrollmentCredential(
      agent.id,
      expiresAt ? { expiresAt } : undefined
    );

    const controlPlaneUrl =
      process.env.DEPLOYKIT_API_ORIGIN ||
      `http://${req.headers.host || "localhost:3000"}`;

    const installCommand = `docker run -d --name dk-agent-${agent.id.slice(0, 8)} \\
  --restart unless-stopped \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -e DEPLOYKIT_CONTROL_PLANE_URL="${controlPlaneUrl}" \\
  -e DEPLOYKIT_AGENT_ID="${agent.id}" \\
  -e DEPLOYKIT_AGENT_TOKEN="${credential.token}" \\
  deploykit-edge-agent:latest`;

    return res.status(201).json({
      agent,
      credential: {
        id: credential.id,
        token: credential.token,
        expiresAt: credential.expiresAt,
      },
      installCommand,
    });
  } catch (error) {
    if (error instanceof AgentError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("Enroll agent error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
    return res.status(500).json({ error: "Failed to enroll server or agent" });
  }
}

export async function revokeProjectAgentController(req: Request, res: Response) {
  try {
    const projectId = String(req.params.id);
    const agentId = String(req.params.agentId);

    const agent = await getAgentById(agentId);
    if (!agent || agent.projectId !== projectId) {
      return res.status(404).json({ error: "Agent not found for this project", code: "AGENT_NOT_FOUND" });
    }

    const revoked = await revokeAgent(agentId);
    if (!revoked) {
      return res.status(400).json({ error: "Could not revoke agent or agent already revoked" });
    }

    return res.json({ message: "Server agent revoked successfully" });
  } catch (error) {
    if (error instanceof AgentError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("Revoke agent error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
    return res.status(500).json({ error: "Failed to revoke agent" });
  }
}
