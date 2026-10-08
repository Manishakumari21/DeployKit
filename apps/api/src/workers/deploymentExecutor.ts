export interface DeploymentExecutionContext {
  deploymentId: string;
  jobId: string;
  attempt: number;
  maxAttempts: number;
  signal?: AbortSignal;
}

export interface DeploymentExecutionResult {
  commitSha: string;
  imageRepository: string;
  imageDigest: string;
  // Present only when this execution converged onto another execution's
  // runtime instead of deploying its own: the adopted (winner) release.
  // Never set on the normal path, so workers can tell convergence apart
  // from a genuine success without parsing messages.
  duplicateConverged?: {
    adoptedReleaseId: string;
  };
}

export interface DeploymentExecutor {
  execute(
    context: DeploymentExecutionContext
  ): Promise<DeploymentExecutionResult>;
}

export class UnconfiguredDeploymentExecutor
  implements DeploymentExecutor
{
  async execute(_context: DeploymentExecutionContext): Promise<DeploymentExecutionResult> {
    throw new Error(
      "DEPLOYMENT_EXECUTOR_NOT_CONFIGURED"
    );
  }
}
