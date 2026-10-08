import { Request, Response } from "express";
import { z } from "zod";
import {
  AgentError,
  getAgentById,
  updateAgentHeartbeat,
  type Agent,
} from "../agents/agentService.js";
import {
  AgentJobError,
  claimAgentJob,
  completeAgentJob,
  failAgentJob,
  heartbeatAgentJob,
  type AgentCompletionInput,
  type AgentFailureInput,
} from "../agents/agentJobService.js";
import { COMMIT_SHA_PATTERN } from "../services/deploymentService.js";
import { DIGEST_PATTERN } from "../services/releaseService.js";

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

const jobIdSchema = z.string().uuid();

const completeBodySchema = z.object({
  outcome: z.enum(["succeeded", "failed"]),
  imageDigest: z.string().regex(DIGEST_PATTERN).optional(),
  commitSha: z.string().regex(COMMIT_SHA_PATTERN).optional(),
  errorCode: z.string().min(1).max(100).optional(),
  errorMessage: z.string().min(1).max(4000).optional(),
});

const failBodySchema = z.object({
  errorCode: z.string().min(1).max(100).optional(),
  errorMessage: z.string().min(1).max(4000),
});

function agentJobId(req: Request, res: Response): string | null {
  const parsed = jobIdSchema.safeParse(req.params.jobId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid job id" });
    return null;
  }
  return parsed.data;
}

function sendAgentJobError(res: Response, error: unknown): void {
  if (error instanceof AgentJobError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  throw error;
}

export async function claimAgentJobController(req: Request, res: Response) {
  try {
    const context = agentContext(req);
    if (!context) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      const job = await claimAgentJob(context.agentId);
      return res.status(200).json({ job });
    } catch (error) {
      sendAgentJobError(res, error);
      return;
    }
  } catch {
    return res.status(500).json({ error: "Failed to claim job" });
  }
}

export async function heartbeatAgentJobController(req: Request, res: Response) {
  try {
    const context = agentContext(req);
    if (!context) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const jobId = agentJobId(req, res);
    if (!jobId) return;
    try {
      const state = await heartbeatAgentJob(context.agentId, jobId);
      return res.status(200).json(state);
    } catch (error) {
      sendAgentJobError(res, error);
      return;
    }
  } catch {
    return res.status(500).json({ error: "Failed to extend lease" });
  }
}

export async function completeAgentJobController(req: Request, res: Response) {
  try {
    const context = agentContext(req);
    if (!context) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const jobId = agentJobId(req, res);
    if (!jobId) return;
    const body = completeBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "Invalid completion payload" });
    }
    if (body.data.outcome === "failed" && body.data.errorMessage === undefined) {
      return res.status(400).json({ error: "errorMessage is required for failed outcome" });
    }
    try {
      const completion = await completeAgentJob(
        context.agentId,
        jobId,
        body.data as AgentCompletionInput
      );
      return res.status(200).json(completion);
    } catch (error) {
      sendAgentJobError(res, error);
      return;
    }
  } catch {
    return res.status(500).json({ error: "Failed to complete job" });
  }
}

export async function failAgentJobController(req: Request, res: Response) {
  try {
    const context = agentContext(req);
    if (!context) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const jobId = agentJobId(req, res);
    if (!jobId) return;
    const body = failBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "Invalid failure payload" });
    }
    try {
      const completion = await failAgentJob(
        context.agentId,
        jobId,
        body.data as AgentFailureInput
      );
      return res.status(200).json(completion);
    } catch (error) {
      sendAgentJobError(res, error);
      return;
    }
  } catch {
    return res.status(500).json({ error: "Failed to record job failure" });
  }
}
