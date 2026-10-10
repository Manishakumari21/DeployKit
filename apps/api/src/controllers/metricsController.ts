import type { Request, Response } from "express";
import pool from "../db/database.js";
import { redactForLog } from "../agents/edgeJobSchema.js";
import { uuidParam, fail } from "./http.js";
import { getProjectMetrics } from "../services/metricsService.js";

export async function getProjectMetricsController(req: Request, res: Response): Promise<void> {
  const id = uuidParam(req, res, "Invalid project id");
  if (!id) return;
  try {
    const project = await pool.query(`SELECT id FROM projects WHERE id = $1`, [id]);
    if (project.rowCount === 0) {
      fail(res, 404, "Project not found");
      return;
    }
    res.json(await getProjectMetrics(id));
  } catch (error) {
    console.error("Get project metrics error:", error instanceof Error ? redactForLog(error.message) : "Unknown error");
    fail(res, 500, "Failed to fetch metrics");
  }
}
