import type { Request, Response } from "express";
import { z } from "zod";
import pool from "../db/database.js";
import { uuidParam, fail } from "./http.js";
import {
  LOG_LEVELS,
  LOG_SOURCES,
  getDeploymentLogUsage,
  listLogs,
} from "../services/deploymentLogService.js";

const querySchema = z.object({
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .transform(Number)
    .optional(),
  limit: z
    .string()
    .regex(/^[0-9]+$/)
    .transform(Number)
    .refine((n) => n >= 1 && n <= 200, "limit must be between 1 and 200")
    .optional(),
  source: z.enum(LOG_SOURCES).optional(),
  level: z.enum(LOG_LEVELS).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});

export async function getDeploymentLogsController(req: Request, res: Response): Promise<void> {
  const id = uuidParam(req, res, "Invalid deployment id");
  if (!id) return;
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, "Invalid log query parameters");
    return;
  }
  try {
    const dep = await pool.query(`SELECT id, project_id FROM deployments WHERE id = $1`, [id]);
    if (dep.rowCount === 0) {
      fail(res, 404, "Deployment not found");
      return;
    }
    const { items, next_cursor } = await listLogs({
      deploymentId: id,
      cursor: parsed.data.cursor ?? null,
      limit: parsed.data.limit ?? 100,
      source: parsed.data.source,
      level: parsed.data.level,
      direction: parsed.data.direction ?? "asc",
    });
    const usage = await getDeploymentLogUsage(id);
    res.json({ items, next_cursor, truncated: usage.truncated });
  } catch (error) {
    console.error("Get deployment logs error:", error);
    fail(res, 500, "Failed to fetch logs");
  }
}
