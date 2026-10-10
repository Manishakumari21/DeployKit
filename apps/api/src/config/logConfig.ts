

export interface LogConfig {
  retentionDays: number;
  maxLinesPerDeployment: number;
  maxBytesPerDeployment: number;
  maxMessageBytes: number;
}

export const DEFAULT_LOG_CONFIG: LogConfig = {
  retentionDays: 30,
  maxLinesPerDeployment: 2000,
  maxBytesPerDeployment: 1024 * 1024, // 1 MiB per deployment
  maxMessageBytes: 8 * 1024, // 8 KiB per line
};

const CEILINGS: LogConfig = {
  retentionDays: 365,
  maxLinesPerDeployment: 20000,
  maxBytesPerDeployment: 10 * 1024 * 1024,
  maxMessageBytes: 64 * 1024,
};

function readPositiveInteger(
  name: string,
  fallback: number,
  ceiling: number
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  if (value > ceiling) {
    throw new Error(`${name} must be <= ${ceiling}`);
  }
  return value;
}

export function getLogConfig(): LogConfig {
  return {
    retentionDays: readPositiveInteger(
      "DEPLOYKIT_LOG_RETENTION_DAYS",
      DEFAULT_LOG_CONFIG.retentionDays,
      CEILINGS.retentionDays
    ),
    maxLinesPerDeployment: readPositiveInteger(
      "DEPLOYKIT_LOG_MAX_LINES_PER_DEPLOYMENT",
      DEFAULT_LOG_CONFIG.maxLinesPerDeployment,
      CEILINGS.maxLinesPerDeployment
    ),
    maxBytesPerDeployment: readPositiveInteger(
      "DEPLOYKIT_LOG_MAX_BYTES_PER_DEPLOYMENT",
      DEFAULT_LOG_CONFIG.maxBytesPerDeployment,
      CEILINGS.maxBytesPerDeployment
    ),
    maxMessageBytes: readPositiveInteger(
      "DEPLOYKIT_LOG_MAX_MESSAGE_BYTES",
      DEFAULT_LOG_CONFIG.maxMessageBytes,
      CEILINGS.maxMessageBytes
    ),
  };
}
