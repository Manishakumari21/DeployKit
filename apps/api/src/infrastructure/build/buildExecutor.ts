export interface BuildPolicy {
  timeoutMs: number;
  memoryBytes: number;
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
  /**
   * When true, build with `--push` (registry mode) instead of
   * `--load` (local mode). Defaults to false to preserve local
   * development behavior. `--load` and `--push` are never combined.
   */
  push?: boolean;
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
