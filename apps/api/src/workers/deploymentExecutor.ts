export interface DeploymentExecutionContext {
  deploymentId: string;
  jobId: string;
  attempt: number;
  maxAttempts: number;
}

export interface DeploymentExecutionResult {
  commitSha: string;
  imageRepository: string;
  imageDigest: string;
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
