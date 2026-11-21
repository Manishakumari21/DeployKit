import type { Request, Response } from "express";
import { z } from "zod";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuid = z.string().regex(UUID_PATTERN);

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function uuidParam(
  req: Request,
  res: Response,
  label = "Invalid id",
  paramName = "id",
  errorCode?: string
): string | null {
  const r = uuid.safeParse(req.params?.[paramName]);
  if (!r.success) {
    const payload: { error: string; code?: string } = { error: label };
    if (errorCode) {
      payload.code = errorCode;
    }
    res.status(400).json(payload);
    return null;
  }
  return r.data;
}

export function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}
