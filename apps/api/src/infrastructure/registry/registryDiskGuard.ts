import { runCommand } from "../process/dockerExec.js";

export interface RegistryDiskUsage {
  usedPercent: number;
  availableKB: number;
}

export interface DiskThresholds {
  softPercent: number;
  hardPercent: number;
}

export const DEFAULT_DISK_THRESHOLDS: DiskThresholds = {
  softPercent: 85,
  hardPercent: 95,
};

export type DiskPressure = "ok" | "soft" | "hard";

// Anchors on the trailing `blocks used available use%` columns so filesystem
// names/mount points containing spaces or digits do not shift the parse.
export function parseDfUsage(stdout: string): RegistryDiskUsage | null {
  const matches = [...stdout.matchAll(/(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/g)];
  if (matches.length === 0) {
    return null;
  }
  const row = matches[matches.length - 1];
  const availableKB = Number(row[3]);
  const usedPercent = Number(row[4]);
  if (!Number.isFinite(availableKB) || !Number.isFinite(usedPercent)) {
    return null;
  }
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    availableKB: Math.max(0, availableKB),
  };
}

export function diskPressureLevel(
  usedPercent: number,
  thresholds: DiskThresholds
): DiskPressure {
  if (usedPercent >= thresholds.hardPercent) {
    return "hard";
  }
  if (usedPercent >= thresholds.softPercent) {
    return "soft";
  }
  return "ok";
}

function clampPercent(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(100, Math.max(1, Math.floor(parsed)));
}

export function readDiskThresholds(
  env: NodeJS.ProcessEnv = process.env
): DiskThresholds {
  const softPercent = clampPercent(
    env.DEPLOYKIT_REGISTRY_DISK_SOFT_PERCENT,
    DEFAULT_DISK_THRESHOLDS.softPercent
  );
  const hardPercent = clampPercent(
    env.DEPLOYKIT_REGISTRY_DISK_HARD_PERCENT,
    DEFAULT_DISK_THRESHOLDS.hardPercent
  );
  // The hard threshold is never allowed below the soft one.
  return { softPercent, hardPercent: Math.max(softPercent, hardPercent) };
}

export interface MeasureDiskOptions {
  dockerBinary?: string;
  registryContainer?: string;
  storagePath?: string;
  timeoutMs?: number;
}

// Returns null when the measurement cannot be taken (no container, no df,
// non-zero exit) so callers fail open rather than block on an unknown reading.
export async function measureRegistryDiskUsage(
  options: MeasureDiskOptions = {}
): Promise<RegistryDiskUsage | null> {
  const dockerBinary =
    options.dockerBinary ?? process.env.DEPLOYKIT_DOCKER_BINARY ?? "docker";
  const registryContainer =
    options.registryContainer ??
    process.env.DEPLOYKIT_REGISTRY_CONTAINER ??
    "deploykit-registry";
  const storagePath =
    options.storagePath ??
    process.env.DEPLOYKIT_REGISTRY_STORAGE_PATH ??
    "/var/lib/registry";
  const timeoutMs = options.timeoutMs ?? 10_000;

  let result;
  try {
    result = await runCommand(
      dockerBinary,
      ["exec", registryContainer, "df", "-k", storagePath],
      timeoutMs
    );
  } catch {
    return null;
  }
  if (result.code !== 0) {
    return null;
  }
  return parseDfUsage(result.stdout);
}
