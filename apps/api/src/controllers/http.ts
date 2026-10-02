import type { Request, Response } from "express";
import { z } from "zod";

const uuid = z.string().uuid();

export function uuidParam(req: Request, res: Response, label = "Invalid id"): string | null {
  const r = uuid.safeParse(req.params.id);
  if (!r.success) {
    res.status(400).json({ error: label });
    return null;
  }
  return r.data;
}

export function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}
