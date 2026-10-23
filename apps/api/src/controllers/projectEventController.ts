import type { Request, Response } from "express";
import { redactForLog } from "../agents/edgeJobSchema.js";
import { getProjectEvents } from "../services/projectEventService.js";

function parseLimit(raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) return 50;
  return Math.min(Math.trunc(value), 100);
}

export async function getProjectEventsController(
  req: Request,
  res: Response
): Promise<void> {
  const projectId = req.projectId ?? String(req.params.id);
  try {
    const events = await getProjectEvents(projectId, parseLimit(req.query.limit));
    res.json(events);
  } catch (error) {
    console.error(
      "Get project events error:",
      error instanceof Error ? redactForLog(error.message) : "Unknown error"
    );
    res.status(500).json({ error: "Failed to fetch project events" });
  }
}
