export interface DatabasePoolConfig {
  connectionString?: string;
  max: number;
  min: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  maxLifetimeSeconds?: number;
}

export const POOL_DEFAULTS = {
  max: 20,
  min: 2,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  maxLifetimeSeconds: 1800, // 30 minutes
} as const;

export const POOL_LIMITS = {
  maxMin: 2,
  maxMax: 100,
  minMin: 0,
  connectionTimeoutMinMs: 500,
  connectionTimeoutMaxMs: 60000,
  idleTimeoutMinMs: 1000,
  idleTimeoutMaxMs: 600000,
} as const;

function parsePositiveInt(val: string | undefined, fallback: number): number {
  if (val === undefined || val.trim() === "") return fallback;
  const num = Number(val);
  if (!Number.isSafeInteger(num) || num < 0) {
    return fallback;
  }
  return num;
}

export function parsePoolConfig(env: NodeJS.ProcessEnv = process.env): DatabasePoolConfig {
  const connectionString = env.DATABASE_URL;

  let max = parsePositiveInt(env.DATABASE_POOL_MAX, POOL_DEFAULTS.max);
  if (max < POOL_LIMITS.maxMin) max = POOL_LIMITS.maxMin;
  if (max > POOL_LIMITS.maxMax) max = POOL_LIMITS.maxMax;

  let min = parsePositiveInt(env.DATABASE_POOL_MIN, POOL_DEFAULTS.min);
  if (min < POOL_LIMITS.minMin) min = POOL_LIMITS.minMin;
  if (min > max) min = max;

  let connectionTimeoutMillis = parsePositiveInt(
    env.DATABASE_POOL_CONNECTION_TIMEOUT_MS ?? env.DATABASE_CONNECT_TIMEOUT_MS,
    POOL_DEFAULTS.connectionTimeoutMillis
  );
  if (connectionTimeoutMillis < POOL_LIMITS.connectionTimeoutMinMs) {
    connectionTimeoutMillis = POOL_LIMITS.connectionTimeoutMinMs;
  }
  if (connectionTimeoutMillis > POOL_LIMITS.connectionTimeoutMaxMs) {
    connectionTimeoutMillis = POOL_LIMITS.connectionTimeoutMaxMs;
  }

  let idleTimeoutMillis = parsePositiveInt(
    env.DATABASE_POOL_IDLE_TIMEOUT_MS,
    POOL_DEFAULTS.idleTimeoutMillis
  );
  if (idleTimeoutMillis < POOL_LIMITS.idleTimeoutMinMs) {
    idleTimeoutMillis = POOL_LIMITS.idleTimeoutMinMs;
  }
  if (idleTimeoutMillis > POOL_LIMITS.idleTimeoutMaxMs) {
    idleTimeoutMillis = POOL_LIMITS.idleTimeoutMaxMs;
  }

  const maxLifetimeSeconds = parsePositiveInt(
    env.DATABASE_POOL_MAX_LIFETIME_MS,
    POOL_DEFAULTS.maxLifetimeSeconds
  );

  return {
    connectionString,
    max,
    min,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    maxLifetimeSeconds,
  };
}
