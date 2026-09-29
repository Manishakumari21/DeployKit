import type { BuildPolicy } from "./buildExecutor.js";

const MB = 1024 * 1024;

export const DEFAULT_BUILD_POLICY: BuildPolicy = {
  timeoutMs: 10 * 60 * 1000,

  memoryBytes: 2 * 1024 * MB,

  cpuLimit: 2,

  networkEnabled: true,

  maxBuildContextBytes: 2 * 1024 * 1024 * 1024,
};

export function getBuildPolicy(): BuildPolicy {
  const policy: BuildPolicy = {
    ...DEFAULT_BUILD_POLICY,

    timeoutMs: readPositiveInteger(
      "DEPLOYKIT_BUILD_TIMEOUT_MS",
      DEFAULT_BUILD_POLICY.timeoutMs
    ),

    memoryBytes: readPositiveInteger(
      "DEPLOYKIT_BUILD_MEMORY_BYTES",
      DEFAULT_BUILD_POLICY.memoryBytes
    ),

    cpuLimit: readPositiveInteger(
      "DEPLOYKIT_BUILD_CPU_LIMIT",
      DEFAULT_BUILD_POLICY.cpuLimit
    ),

    maxBuildContextBytes: readPositiveInteger(
      "DEPLOYKIT_MAX_BUILD_CONTEXT_BYTES",
      DEFAULT_BUILD_POLICY.maxBuildContextBytes
    ),
  };

  // Sane upper bounds so a misconfigured env cannot OOM the builder host.
  if (policy.timeoutMs > 60 * 60 * 1000) {
    throw new Error(
      "DEPLOYKIT_BUILD_TIMEOUT_MS must be <= 3600000"
    );
  }
  if (policy.memoryBytes > 64 * 1024 * MB) {
    throw new Error(
      "DEPLOYKIT_BUILD_MEMORY_BYTES must be <= 68719476736"
    );
  }
  if (policy.cpuLimit > 32) {
    throw new Error(
      "DEPLOYKIT_BUILD_CPU_LIMIT must be <= 32"
    );
  }

  return policy;
}

function readPositiveInteger(
  name: string,
  fallback: number
): number {
  const raw = process.env[name];

  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive safe integer`
    );
  }

  return value;
}
