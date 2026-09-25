import "dotenv/config";

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export const env = {
  PORT: Number(process.env.PORT ?? "3000"),
  DATABASE_URL: process.env.DATABASE_URL ?? "",
};

export function assertEnv(): void {
  if (Number.isNaN(env.PORT)) {
    throw new Error("PORT must be a number");
  }
}

// Optional strict check, call explicitly if DB is required
export function requireDatabaseUrl(): string {
  return requireEnv("DATABASE_URL");
}
