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

  labels?: Record<string, string>;
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
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void>;

  pull(reference: string, signal?: AbortSignal): Promise<void>;

  containerLogs?(containerName: string, tailLines?: number): Promise<string>;
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
    _timeoutMs: number,
    _signal?: AbortSignal): Promise<void> {
    throw new Error(
      "RUNTIME_MANAGER_NOT_CONFIGURED"
    );
  }

  async pull(_reference: string, _signal?: AbortSignal): Promise<void> {
    throw new Error(
      "RUNTIME_MANAGER_NOT_CONFIGURED"
    );
  }

  async containerLogs(_containerName: string, _tailLines?: number): Promise<string> {
    return "";
  }
}
