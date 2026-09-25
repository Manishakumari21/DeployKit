import { Pool } from "pg";
import { env } from "../config/env.js";

export const pool = env.DATABASE_URL
  ? new Pool({ connectionString: env.DATABASE_URL })
  : null;

export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  if (!pool) {
    throw new Error("DATABASE_URL is not set, database unavailable");
  }
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function checkDatabase(): Promise<boolean> {
  if (!pool) return false;
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
