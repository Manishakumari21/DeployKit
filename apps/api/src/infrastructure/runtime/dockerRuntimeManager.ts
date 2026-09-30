import { spawn } from "node:child_process";

import type {
  RuntimeInfo,
  RuntimeManager,
  RuntimeSpec,
} from "./runtimeManager.js";

const DEFAULT_DOCKER_BINARY = "docker";

const MAX_OUTPUT_BYTES = 64 * 1024;

export class RuntimeManagerError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string
  ) {
    super(message);
    this.name = "RuntimeManagerError";
    this.code = code;
  }
}

function validateContainerName(
  name: string
): string {
  const value = name.trim();

  if (
    !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(value)
  ) {
    throw new RuntimeManagerError(
      "INVALID_CONTAINER_NAME",
      "Invalid runtime container name"
    );
  }

  return value;
}

function validateNetworkName(
  name: string
): string {
  const value = name.trim();

  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(value)
  ) {
    throw new RuntimeManagerError(
      "INVALID_NETWORK_NAME",
      "Invalid runtime network name"
    );
  }

  return value;
}

function validateContainerPort(
  port: number
): number {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new RuntimeManagerError(
      "INVALID_CONTAINER_PORT",
      "Container port must be between 1 and 65535"
    );
  }

  return port;
}

function validateHealthPath(
  path: string
): string {
  const value = path.trim();

  if (!value.startsWith("/")) {
    throw new RuntimeManagerError(
      "INVALID_HEALTH_PATH",
      "Health path must start with /"
    );
  }

  if (
    value.includes("\r") ||
    value.includes("\n") ||
    value.length > 1024
  ) {
    throw new RuntimeManagerError(
      "INVALID_HEALTH_PATH",
      "Invalid health path"
    );
  }

  return value;
}

function validateImageReference(ref: string): string {
  const value = ref.trim();
  if (!/@sha256:[0-9a-f]{64}$/i.test(value)) {
    throw new RuntimeManagerError(
      "INVALID_IMAGE_REFERENCE",
      "Runtime image must be an immutable digest reference (repository@sha256:...)"
    );
  }
  if (value.length > 1024 || /[\s'"`$\\]/.test(value)) {
    throw new RuntimeManagerError(
      "INVALID_IMAGE_REFERENCE",
      "Invalid runtime image reference"
    );
  }
  return value;
}

function validateEnvironment(
  env: Record<string, string>
): void {
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new RuntimeManagerError(
        "INVALID_ENV_NAME",
        `Invalid environment variable name: ${key}`
      );
    }
    if (key.length > 128 || value.length > 32768) {
      throw new RuntimeManagerError(
        "INVALID_ENV_VALUE",
        `Environment variable out of bounds: ${key}`
      );
    }
    if (/[\r\n\0]/.test(value)) {
      throw new RuntimeManagerError(
        "INVALID_ENV_VALUE",
        `Environment variable contains invalid characters: ${key}`
      );
    }
  }
}
function appendTail(
  current: string,
  chunk: Buffer | string
): string {
  const next = current + chunk.toString();

  if (
    Buffer.byteLength(next, "utf8") <=
    MAX_OUTPUT_BYTES
  ) {
    return next;
  }

  const buffer = Buffer.from(next, "utf8");

  return buffer
    .subarray(
      buffer.length - MAX_OUTPUT_BYTES
    )
    .toString("utf8");
}

function runDocker(
  binary: string,
  args: string[],
  timeoutMs = 30_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      args,
      {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");

      if (!settled) {
        settled = true;

        reject(
          new RuntimeManagerError(
            "DOCKER_TIMEOUT",
            "Docker command timed out"
          )
        );
      }
    }, timeoutMs);

    child.stdout.on(
      "data",
      (chunk: Buffer) => {
        stdout = appendTail(stdout, chunk);
      }
    );

    child.stderr.on(
      "data",
      (chunk: Buffer) => {
        stderr = appendTail(stderr, chunk);
      }
    );

    child.on(
      "error",
      (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);

        reject(
          new RuntimeManagerError(
            "DOCKER_COMMAND_FAILED",
            error.message
          )
        );
      }
    );

    child.on(
      "close",
      (code) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);

        if (code !== 0) {
          reject(
            new RuntimeManagerError(
              "DOCKER_COMMAND_FAILED",
              stderr.trim() ||
                `Docker exited with code ${code}`
            )
          );

          return;
        }

        resolve(stdout.trim());
      }
    );
  });
}

export interface DockerRuntimeManagerOptions {
  dockerBinary?: string;
}

export class DockerRuntimeManager
  implements RuntimeManager
{
  private readonly dockerBinary: string;

  constructor(
    options: DockerRuntimeManagerOptions = {}
  ) {
    this.dockerBinary =
      options.dockerBinary ??
      process.env.DEPLOYKIT_DOCKER_BINARY ??
      DEFAULT_DOCKER_BINARY;
  }

  async create(
    spec: RuntimeSpec
  ): Promise<RuntimeInfo> {
    const containerName =
      validateContainerName(
        spec.containerName
      );

    const networkName =
      validateNetworkName(
        spec.networkName
      );

    const containerPort =
      validateContainerPort(
        spec.containerPort
      );

    const healthPath =
      validateHealthPath(
        spec.healthPath
      );

    if (
      !Number.isSafeInteger(spec.memoryBytes) ||
      spec.memoryBytes <= 0
    ) {
      throw new RuntimeManagerError(
        "INVALID_MEMORY_LIMIT",
        "Invalid runtime memory limit"
      );
    }

    if (
      !Number.isSafeInteger(spec.cpuLimit) ||
      spec.cpuLimit <= 0
    ) {
      throw new RuntimeManagerError(
        "INVALID_CPU_LIMIT",
        "Invalid runtime CPU limit"
      );
    }

    if (
      !Number.isSafeInteger(spec.pidsLimit) ||
      spec.pidsLimit <= 0
    ) {
      throw new RuntimeManagerError(
        "INVALID_PIDS_LIMIT",
        "Invalid runtime PID limit"
      );
    }

    validateEnvironment(spec.environment);

    const imageReference = validateImageReference(
      spec.imageReference
    );

    const args = [
      "container",
      "create",

      "--name",
      containerName,

      "--network",
      networkName,

      "--restart",
      "no",

      "--init",

      "--read-only",

      "--cap-drop",
      "ALL",

      "--security-opt",
      "no-new-privileges:true",

      "--memory",
      String(spec.memoryBytes),

      "--cpus",
      String(spec.cpuLimit),

      "--pids-limit",
      String(spec.pidsLimit),

      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=256m",

      "--label",
      "io.deploykit.managed=true",

      "--label",
      `io.deploykit.container=${containerName}`,

      "--label",
      `io.deploykit.health-path=${healthPath}`,

      "--label",
      `io.deploykit.container-port=${validateContainerPort(spec.containerPort)}`,
    ];

    for (
      const [key, value]
      of Object.entries(spec.environment)
    ) {
      args.push(
        "--env",
        `${key}=${value}`
      );
    }

    args.push(imageReference);

    const rawId = await runDocker(this.dockerBinary, args);
    const containerId = rawId.trim().split(/\s+/)[0];

    if (!/^[0-9a-f]{64}$/i.test(containerId)) {
      await runDocker(this.dockerBinary, [
        "container",
        "rm",
        "--force",
        containerName,
      ]).catch(() => undefined);
      throw new RuntimeManagerError(
        "DOCKER_COMMAND_FAILED",
        "Docker returned an invalid container ID"
      );
    }

    return {
      containerId,
      containerName,
      containerPort: validateContainerPort(spec.containerPort),
      ipAddress: "",
      networkName,
      healthPath,
    };
  }

  async start(
    containerName: string
  ): Promise<void> {
    validateContainerName(
      containerName
    );

    await runDocker(
      this.dockerBinary,
      [
        "container",
        "start",
        containerName,
      ]
    );
  }

  async stop(
    containerName: string
  ): Promise<void> {
    validateContainerName(
      containerName
    );

    await runDocker(
      this.dockerBinary,
      [
        "container",
        "stop",
        "--time",
        "10",
        containerName,
      ]
    );
  }

  async remove(
    containerName: string
  ): Promise<void> {
    validateContainerName(
      containerName
    );

    await runDocker(
      this.dockerBinary,
      [
        "container",
        "rm",
        "--force",
        containerName,
      ]
    );
  }

  async inspect(
    containerName: string,
    expectedNetwork?: string
  ): Promise<RuntimeInfo> {
    const target = containerName.trim();
    if (!target) {
      throw new RuntimeManagerError(
        "INVALID_CONTAINER_NAME",
        "Invalid runtime container name"
      );
    }

    const raw = await runDocker(this.dockerBinary, [
      "container",
      "inspect",
      "--format",
      "{{json .}}",
      target,
    ]);

    let data: {
      Id?: string;
      Name?: string;
      Config?: {
        ExposedPorts?: Record<string, unknown>;
        Labels?: Record<string, string>;
      };
      NetworkSettings?: {
        Networks?: Record<string, { IPAddress?: string }>;
      };
    };

    try {
      data = JSON.parse(raw);
    } catch {
      throw new RuntimeManagerError(
        "INVALID_DOCKER_RESPONSE",
        "Docker returned invalid inspection data"
      );
    }

    if (!data.Id || !data.Name) {
      throw new RuntimeManagerError(
        "RUNTIME_NOT_FOUND",
        "Docker runtime information is incomplete"
      );
    }

    const networks = data.NetworkSettings?.Networks ?? {};

    let networkName = "";
    let ipAddress = "";
    if (expectedNetwork) {
      const entry = networks[expectedNetwork];
      if (!entry?.IPAddress) {
        throw new RuntimeManagerError(
          "RUNTIME_IP_UNAVAILABLE",
          `Runtime container is not attached to network ${expectedNetwork}`
        );
      }
      networkName = expectedNetwork;
      ipAddress = entry.IPAddress;
    } else {
      for (const [name, entry] of Object.entries(networks)) {
        if (entry.IPAddress) {
          networkName = name;
          ipAddress = entry.IPAddress;
          break;
        }
      }
    }

    if (!ipAddress) {
      throw new RuntimeManagerError(
        "RUNTIME_IP_UNAVAILABLE",
        "Runtime container has no network address"
      );
    }

    const healthPath = validateHealthPath(
      data.Config?.Labels?.["io.deploykit.health-path"] ?? "/"
    );
    const labeledPort = Number(
      data.Config?.Labels?.["io.deploykit.container-port"]
    );
    const exposedPorts = Object.keys(
      data.Config?.ExposedPorts ?? {}
    );
    const exposedPort = Number(exposedPorts[0]?.split("/")[0]);
    const containerPort =
      Number.isSafeInteger(labeledPort) && labeledPort >= 1 && labeledPort <= 65535
        ? labeledPort
        : exposedPort;

    if (
      !Number.isSafeInteger(containerPort) ||
      containerPort < 1 ||
      containerPort > 65535
    ) {
      throw new RuntimeManagerError(
        "RUNTIME_PORT_UNAVAILABLE",
        "Runtime container does not expose a port"
      );
    }

    return {
      containerId: data.Id,
      containerName: data.Name.replace(/^\//, ""),
      containerPort,
      ipAddress,
      networkName,
      healthPath,
    };
  }

  async waitForHealthy(
    runtime: RuntimeInfo,
    timeoutMs: number
  ): Promise<void> {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new RuntimeManagerError(
        "INVALID_HEALTH_TIMEOUT",
        "Health-check timeout must be positive"
      );
    }

    const deadline = Date.now() + timeoutMs;

    const healthPath = validateHealthPath(
      runtime.healthPath ?? "/"
    );

    let lastError = "No response";

    while (Date.now() < deadline) {
      try {
        const response = await fetch(
          `http://${runtime.ipAddress}:${runtime.containerPort}${healthPath}`,
          {
            signal: AbortSignal.timeout(3_000),
            redirect: "manual",
          }
        );

        if (
          response.status >= 200 &&
          response.status < 400
        ) {
          return;
        }

        lastError =
          `HTTP ${response.status}`;
      } catch (error) {
        lastError =
          error instanceof Error
            ? error.message
            : "Health check failed";
      }

      await new Promise(
        (resolve) =>
          setTimeout(resolve, 1_000)
      );
    }

    throw new RuntimeManagerError(
      "RUNTIME_HEALTH_TIMEOUT",
      `Runtime did not become healthy: ${lastError}`
    );
  }
}
