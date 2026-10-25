import type { Request, Response } from "express";
import { redactForLog } from "../agents/edgeJobSchema.js";
import {
  acknowledgeIncident,
  getIncident,
  IncidentKind,
  INCIDENT_KINDS,
  IncidentNotFoundError,
  IncidentStateError,
  listIncidents,
  resolveIncident,
} from "../services/incidentService.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ListStatus = "active" | "open" | "acknowledged" | "resolved" | "all";

function parseLimit(raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) return 50;
  return Math.min(Math.trunc(value), 100);
}

function parseStatus(raw: unknown): ListStatus {
  const allowed: ListStatus[] = [
    "active",
    "open",
    "acknowledged",
    "resolved",
    "all",
  ];
  if (typeof raw === "string" && (allowed as string[]).includes(raw)) {
    return raw as ListStatus;
  }
  return "active";
}

function parseKind(raw: unknown): IncidentKind | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  return (INCIDENT_KINDS as readonly string[]).includes(raw)
    ? (raw as IncidentKind)
    : undefined;
}

function projectIdOf(req: Request): string {
  return req.projectId ?? String(req.params.id);
}

function incidentIdOf(req: Request): string | null {
  const raw = req.params.incidentId;
  return typeof raw === "string" && UUID_PATTERN.test(raw) ? raw : null;
}

export async function listIncidentsController(
  req: Request,
  res: Response
): Promise<void> {
  const rawKind = req.query.kind;
  if (
    typeof rawKind === "string" &&
    rawKind !== "" &&
    parseKind(rawKind) === undefined
  ) {
    res.status(400).json({ error: "Invalid incident kind" });
    return;
  }
  try {
    const incidents = await listIncidents({
      projectId: projectIdOf(req),
      status: parseStatus(req.query.status),
      kind: parseKind(req.query.kind),
      limit: parseLimit(req.query.limit),
    });
    res.json(incidents);
  } catch (error) {
    console.error(
      "List incidents error:",
      error instanceof Error ? redactForLog(error.message) : "Unknown error"
    );
    res.status(500).json({ error: "Failed to list incidents" });
  }
}

export async function getIncidentController(
  req: Request,
  res: Response
): Promise<void> {
  const incidentId = incidentIdOf(req);
  if (!incidentId) {
    res.status(400).json({ error: "Invalid incident id" });
    return;
  }
  try {
    const incident = await getIncident({
      projectId: projectIdOf(req),
      incidentId,
    });
    res.json(incident);
  } catch (error) {
    if (error instanceof IncidentNotFoundError) {
      res.status(404).json({ error: "Incident not found" });
      return;
    }
    console.error(
      "Get incident error:",
      error instanceof Error ? redactForLog(error.message) : "Unknown error"
    );
    res.status(500).json({ error: "Failed to fetch incident" });
  }
}

export async function acknowledgeIncidentController(
  req: Request,
  res: Response
): Promise<void> {
  const incidentId = incidentIdOf(req);
  if (!incidentId) {
    res.status(400).json({ error: "Invalid incident id" });
    return;
  }
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const incident = await acknowledgeIncident({
      projectId: projectIdOf(req),
      incidentId,
      userId,
    });
    res.json(incident);
  } catch (error) {
    if (error instanceof IncidentNotFoundError) {
      res.status(404).json({ error: "Incident not found" });
      return;
    }
    if (error instanceof IncidentStateError) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error(
      "Acknowledge incident error:",
      error instanceof Error ? redactForLog(error.message) : "Unknown error"
    );
    res.status(500).json({ error: "Failed to acknowledge incident" });
  }
}

export async function resolveIncidentController(
  req: Request,
  res: Response
): Promise<void> {
  const incidentId = incidentIdOf(req);
  if (!incidentId) {
    res.status(400).json({ error: "Invalid incident id" });
    return;
  }
  try {
    const incident = await resolveIncident({
      projectId: projectIdOf(req),
      incidentId,
    });
    res.json(incident);
  } catch (error) {
    if (error instanceof IncidentNotFoundError) {
      res.status(404).json({ error: "Incident not found" });
      return;
    }
    if (error instanceof IncidentStateError) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error(
      "Resolve incident error:",
      error instanceof Error ? redactForLog(error.message) : "Unknown error"
    );
    res.status(500).json({ error: "Failed to resolve incident" });
  }
}
