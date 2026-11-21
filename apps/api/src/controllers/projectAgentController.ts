import { Request, Response } from "express";
import { uuidParam } from "./http.js";
import {
  listProjectAgents,
  createAgent,
  createEnrollmentCredential,
  revokeAgent,
  getAgentById,
  AgentError,
} from "../agents/agentService.js";
import { redactForLog } from "../agents/edgeJobSchema.js";

export interface ProjectAgentControllerDeps {
  listProjectAgents?: typeof listProjectAgents;
  createAgent?: typeof createAgent;
  createEnrollmentCredential?: typeof createEnrollmentCredential;
  revokeAgent?: typeof revokeAgent;
  getAgentById?: typeof getAgentById;
}

export function createProjectAgentControllers(deps: ProjectAgentControllerDeps = {}) {
  const listAgents = deps.listProjectAgents ?? listProjectAgents;
  const createAg = deps.createAgent ?? createAgent;
  const createCred = deps.createEnrollmentCredential ?? createEnrollmentCredential;
  const revokeAg = deps.revokeAgent ?? revokeAgent;
  const getAgById = deps.getAgentById ?? getAgentById;

  return {
    listProjectAgentsController: async (req: Request, res: Response) => {
      try {
        const projectId = uuidParam(req, res, "Invalid project id", "id", "INVALID_ID");
        if (!projectId) return;
        const agents = await listAgents(projectId);
        return res.json(agents);
      } catch (error) {
        if (error instanceof AgentError) {
          return res.status(error.status).json({ error: error.message, code: error.code });
        }
        console.error("List project agents error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
        return res.status(500).json({ error: "Failed to list servers and edge agents" });
      }
    },

    enrollProjectAgentController: async (req: Request, res: Response) => {
      try {
        const projectId = uuidParam(req, res, "Invalid project id", "id", "INVALID_ID");
        if (!projectId) return;
        const { name, expiresAt } = req.body ?? {};

        if (typeof name !== "string" || !name.trim()) {
          return res.status(400).json({ error: "Agent/Server name is required", code: "INVALID_NAME" });
        }

        const agent = await createAg(projectId, name.trim());
        const credential = await createCred(
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
    },

    revokeProjectAgentController: async (req: Request, res: Response) => {
      try {
        const projectId = uuidParam(req, res, "Invalid project id", "id", "INVALID_ID");
        if (!projectId) return;
        const agentId = uuidParam(req, res, "Invalid agent id", "agentId", "INVALID_ID");
        if (!agentId) return;

        const agent = await getAgById(agentId);
        if (!agent || agent.projectId !== projectId) {
          return res.status(404).json({ error: "Agent not found for this project", code: "AGENT_NOT_FOUND" });
        }

        const revoked = await revokeAg(agentId);
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
    },
  };
}

export const {
  listProjectAgentsController,
  enrollProjectAgentController,
  revokeProjectAgentController,
} = createProjectAgentControllers();
