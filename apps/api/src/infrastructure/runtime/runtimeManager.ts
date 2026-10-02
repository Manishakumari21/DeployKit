export interface RuntimeSpec {
  containerName: string;
  imageReference: string;

  networkName: string;

  containerPort: number;

  environment: Record<string, string>;

  healthPath: string;

  memoryBytes: number;
  cpuLimit: number;
  pidsLimit: number;
}

export interface RuntimeInfo {
  containerId: string;
  containerName: string;
  containerPort: number;
  ipAddress: string;
  networkName: string;
  healthPath: string;
}

export interface RuntimeManager {
  create(spec: RuntimeSpec): Promise<RuntimeInfo>;

  start(containerName: string): Promise<void>;

  stop(containerName: string): Promise<void>;

  remove(containerName: string): Promise<void>;

  inspect(
    containerName: string,
    expectedNetwork?: string
  ): Promise<RuntimeInfo>;

  waitForHealthy(
    runtime: RuntimeInfo,
    timeoutMs: number
  ): Promise<void>;

  /** Pull repository@sha256:... so create never relies on local cache. */
  pull(reference: string): Promise<void>;
}

export class UnconfiguredRuntimeManager
  implements RuntimeManager
{
  async create(_spec: RuntimeSpec): Promise<RuntimeInfo> {
    throw new Error(
      "RUNTIME_MANAGER_NOT_CONFIGURED"
    );
  }

  async start(_containerName: string): Promise<void> {
    throw new Error(
      "RUNTIME_MANAGER_NOT_CONFIGURED"
    );
  }

  async stop(_containerName: string): Promise<void> {
    throw new Error(
      "RUNTIME_MANAGER_NOT_CONFIGURED"
    );
  }

  async remove(_containerName: string): Promise<void> {
    throw new Error(
      "RUNTIME_MANAGER_NOT_CONFIGURED"
    );
  }

  async inspect(_containerName: string,
    _expectedNetwork?: string): Promise<RuntimeInfo> {
    throw new Error(
      "RUNTIME_MANAGER_NOT_CONFIGURED"
    );
  }

  async waitForHealthy(_runtime: RuntimeInfo,
    _timeoutMs: number): Promise<void> {
    throw new Error(
      "RUNTIME_MANAGER_NOT_CONFIGURED"
    );
  }

  async pull(_reference: string): Promise<void> {
    throw new Error(
      "RUNTIME_MANAGER_NOT_CONFIGURED"
    );
  }
}
