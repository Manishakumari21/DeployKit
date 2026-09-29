export interface BuildPolicy {
  timeoutMs: number;
  /** Enforced via `docker buildx --resource memory=...`. */
  memoryBytes: number;
  /** Enforced via `docker buildx --resource cpu-quota=...` (period 100000). */
  cpuLimit: number;
  networkEnabled: boolean;
  maxBuildContextBytes: number;
}

export interface BuildRequest {
  workspace: string;
  imageRepository: string;
  imageTag: string;
  commitSha: string;
  policy: BuildPolicy;
}

export interface BuildResult {
  imageReference: string;
  imageDigest: string;
}

export interface BuildExecutor {
  build(request: BuildRequest): Promise<BuildResult>;
}

export class UnconfiguredBuildExecutor
  implements BuildExecutor
{
  async build(
    _request: BuildRequest
  ): Promise<BuildResult> {
    throw new Error(
      "BUILD_EXECUTOR_NOT_CONFIGURED"
    );
  }
}
