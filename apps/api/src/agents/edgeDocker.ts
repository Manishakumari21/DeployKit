

import { runCommand, type ExecResult } from "../infrastructure/process/dockerExec.js";
import {
  DockerRuntimeManager,
  RuntimeManagerError,
} from "../infrastructure/runtime/dockerRuntimeManager.js";
import type {
  RuntimeInfo,
  RuntimeManager,
} from "../infrastructure/runtime/runtimeManager.js";
import {
  boundErrorMessage,
  parseImageReference,
  redactForLog,
  toImageReference,
  UUID_PATTERN,
} from "./edgeJobSchema.js";

export const EDGE_CONTAINER_NAME_PATTERN = /^dk-p[0-9a-f]{8}-d[0-9a-f]{8}$/;
export const EDGE_MANAGED_LABEL = "io.deploykit.managed";
export const EDGE_DEPLOYMENT_LABEL = "io.deploykit.deployment";
export const EDGE_PROJECT_LABEL = "io.deploykit.project";
export const EDGE_AGENT_LABEL = "io.deploykit.agent";

const DEFAULT_NETWORK = "deploykit-runtime";
const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;
const DEFAULT_CPU_LIMIT = 1;
const DEFAULT_PIDS_LIMIT = 256;
const DEFAULT_CONTAINER_PORT = 3000;
const DEFAULT_HEALTH_PATH = "/";
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;

const MIN_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;
const MIN_CPU_LIMIT = 1;
const MAX_CPU_LIMIT = 16;
const MIN_PIDS_LIMIT = 16;
const MAX_PIDS_LIMIT = 4096;
const MIN_HEALTH_TIMEOUT_MS = 5_000;
const MAX_HEALTH_TIMEOUT_MS = 300_000;

const NETWORK_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export class EdgeDockerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EdgeDockerError";
    this.code = code;
  }
}

export interface EdgeOwnedIdentity {
  deploymentId: string;
  projectId: string;
  agentId: string;
}

export interface EdgeDockerOptions {
  dockerBinary?: string;
  networkName?: string;
  memoryBytes?: number;
  cpuLimit?: number;
  pidsLimit?: number;
  containerPort?: number;
  healthPath?: string;
  healthTimeoutMs?: number;

  runtimeManager?: RuntimeManager;

  runFn?: typeof runCommand;
}

function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toLowerCase();
}

function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new EdgeDockerError("EDGE_INVALID_ID", `Invalid ${field}: expected UUID`);
  }
  return value;
}

export function edgeContainerName(projectId: string, deploymentId: string): string {
  requireUuid(projectId, "project id");
  requireUuid(deploymentId, "deployment id");
  return `dk-p${shortId(projectId)}-d${shortId(deploymentId)}`;
}

export function assertEdgeContainerName(name: string): string {
  if (!EDGE_CONTAINER_NAME_PATTERN.test(name)) {
    throw new EdgeDockerError("EDGE_NOT_OWNED", "Refusing to operate on a container outside the edge naming convention");
  }
  return name;
}

function intInRange(value: number | undefined, def: number, min: number, max: number, field: string): number {
  if (value === undefined) return def;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new EdgeDockerError("EDGE_INVALID_LIMIT", `${field} must be an integer ${min}..${max}`);
  }
  return value;
}

export interface EdgeRuntimeConfig {
  dockerBinary: string;
  networkName: string;
  memoryBytes: number;
  cpuLimit: number;
  pidsLimit: number;
  containerPort: number;
  healthPath: string;
  healthTimeoutMs: number;
}

export function resolveEdgeRuntimeConfig(options: EdgeDockerOptions = {}): EdgeRuntimeConfig {
  const dockerBinary = (options.dockerBinary ?? process.env.DEPLOYKIT_DOCKER_BINARY ?? "docker").trim();
  if (!dockerBinary || /[\s'"`$\\]/.test(dockerBinary) || dockerBinary.length > 256) {
    throw new EdgeDockerError("EDGE_INVALID_CONFIG", "Invalid Docker binary");
  }
  const networkName = (options.networkName ?? process.env.DEPLOYKIT_EDGE_NETWORK ?? DEFAULT_NETWORK).trim();
  if (!NETWORK_PATTERN.test(networkName)) {
    throw new EdgeDockerError("EDGE_INVALID_CONFIG", "Invalid Docker network name");
  }
  if (networkName.toLowerCase() === "host") {
    throw new EdgeDockerError("EDGE_INVALID_CONFIG", "Host networking is forbidden on edge agents");
  }
  const healthPath = (options.healthPath ?? DEFAULT_HEALTH_PATH).trim();
  if (!healthPath.startsWith("/") || healthPath.length > 1024 || /[\r\n]/.test(healthPath)) {
    throw new EdgeDockerError("EDGE_INVALID_CONFIG", "Health path must start with / and be bounded");
  }
  return {
    dockerBinary,
    networkName,
    memoryBytes: intInRange(options.memoryBytes, DEFAULT_MEMORY_BYTES, MIN_MEMORY_BYTES, MAX_MEMORY_BYTES, "memoryBytes"),
    cpuLimit: intInRange(options.cpuLimit, DEFAULT_CPU_LIMIT, MIN_CPU_LIMIT, MAX_CPU_LIMIT, "cpuLimit"),
    pidsLimit: intInRange(options.pidsLimit, DEFAULT_PIDS_LIMIT, MIN_PIDS_LIMIT, MAX_PIDS_LIMIT, "pidsLimit"),
    containerPort: intInRange(options.containerPort, DEFAULT_CONTAINER_PORT, 1, 65535, "containerPort"),
    healthPath,
    healthTimeoutMs: intInRange(options.healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, MIN_HEALTH_TIMEOUT_MS, MAX_HEALTH_TIMEOUT_MS, "healthTimeoutMs"),
  };
}

export class EdgeDockerRuntime {
  private readonly config: EdgeRuntimeConfig;
  private readonly manager: RuntimeManager;
  private readonly run: typeof runCommand;

  constructor(options: EdgeDockerOptions = {}) {
    this.config = resolveEdgeRuntimeConfig(options);
    this.manager =
      options.runtimeManager ??
      new DockerRuntimeManager({ dockerBinary: this.config.dockerBinary });
    this.run = options.runFn ?? runCommand;
  }

  get runtimeConfig(): EdgeRuntimeConfig {
    return { ...this.config };
  }

  async pullImage(imageReference: string, signal?: AbortSignal): Promise<string> {
    let pinned: string;
    try {
      pinned = toImageReference(parseImageReference(imageReference));
    } catch (error) {
      throw new EdgeDockerError(
        "EDGE_PULL_FAILED",
        boundErrorMessage(
          error instanceof Error ? error.message : "Invalid image reference",
          "Image pull failed"
        ).slice(0, 500)
      );
    }
    try {
      await this.manager.pull(pinned, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw new EdgeDockerError("EDGE_CANCELLED", "Image pull was cancelled");
      }
      const detail = error instanceof Error ? error.message : "Image pull failed";
      throw new EdgeDockerError(
        "EDGE_PULL_FAILED",
        boundErrorMessage(`Image pull failed: ${detail}`, "Image pull failed").slice(0, 500)
      );
    }
    return pinned;
  }

  async createAndStart(
    identity: EdgeOwnedIdentity,
    imageReference: string,
    signal?: AbortSignal
  ): Promise<RuntimeInfo> {
    requireUuid(identity.deploymentId, "deployment id");
    requireUuid(identity.projectId, "project id");
    requireUuid(identity.agentId, "agent id");
    let pinned: string;
    try {
      pinned = toImageReference(parseImageReference(imageReference));
    } catch (error) {
      throw new EdgeDockerError(
        "EDGE_START_FAILED",
        boundErrorMessage(
          error instanceof Error ? error.message : "Invalid image reference",
          "Container startup failed"
        ).slice(0, 500)
      );
    }
    const containerName = edgeContainerName(identity.projectId, identity.deploymentId);
    if (signal?.aborted) {
      throw new EdgeDockerError("EDGE_CANCELLED", "Container creation was cancelled");
    }
    try {
      const created = await this.manager.create({
        containerName,
        imageReference: pinned,
        networkName: this.config.networkName,
        containerPort: this.config.containerPort,
        environment: {
          PORT: String(this.config.containerPort),
          DEPLOYKIT_DEPLOYMENT_ID: identity.deploymentId,
        },
        healthPath: this.config.healthPath,
        memoryBytes: this.config.memoryBytes,
        cpuLimit: this.config.cpuLimit,
        pidsLimit: this.config.pidsLimit,
        labels: {
          [EDGE_DEPLOYMENT_LABEL]: identity.deploymentId,
          [EDGE_PROJECT_LABEL]: identity.projectId,
          [EDGE_AGENT_LABEL]: identity.agentId,
        },
      });
      await this.manager.start(created.containerName);
      return this.manager.inspect(created.containerName, this.config.networkName);
    } catch (error) {
      if (error instanceof EdgeDockerError) throw error;
      if (signal?.aborted) {
        throw new EdgeDockerError("EDGE_CANCELLED", "Container startup was cancelled");
      }
      const detail = error instanceof Error ? error.message : "Container startup failed";
      throw new EdgeDockerError(
        "EDGE_START_FAILED",
        boundErrorMessage(`Container startup failed: ${detail}`, "Container startup failed").slice(0, 500)
      );
    }
  }

  async waitHealthy(runtime: RuntimeInfo, signal?: AbortSignal): Promise<void> {
    try {
      await this.manager.waitForHealthy(runtime, this.config.healthTimeoutMs, signal);
    } catch (error) {
      if (error instanceof RuntimeManagerError && error.code === "RUNTIME_CANCELLED") {
        throw new EdgeDockerError("EDGE_CANCELLED", "Health verification was cancelled");
      }
      if (signal?.aborted) {
        throw new EdgeDockerError("EDGE_CANCELLED", "Health verification was cancelled");
      }
      const detail = error instanceof Error ? error.message : "Health check failed";
      throw new EdgeDockerError(
        "EDGE_HEALTH_CHECK_FAILED",
        boundErrorMessage(`Health check failed: ${detail}`, "Health check failed").slice(0, 500)
      );
    }
  }

  async readLabels(containerName: string): Promise<Record<string, string> | null> {
    assertEdgeContainerName(containerName);
    let result: ExecResult;
    try {
      result = await this.run(
        this.config.dockerBinary,
        ["container", "inspect", "--format", "{{json .Config.Labels}}", containerName],
        15_000
      );
    } catch {
      return null;
    }
    if (result.timedOut || result.aborted || result.code !== 0) return null;
    try {
      const parsed = JSON.parse(result.stdout.trim() || "null") as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return null;
    }
  }

  async assertOwned(containerName: string, identity: EdgeOwnedIdentity): Promise<void> {
    assertEdgeContainerName(containerName);
    const expectedName = edgeContainerName(identity.projectId, identity.deploymentId);
    if (containerName !== expectedName) {
      throw new EdgeDockerError("EDGE_NOT_OWNED", "Container name does not match this deployment");
    }
    const labels = await this.readLabels(containerName);
    if (
      labels === null ||
      labels[EDGE_MANAGED_LABEL] !== "true" ||
      labels[EDGE_DEPLOYMENT_LABEL] !== identity.deploymentId ||
      labels[EDGE_PROJECT_LABEL] !== identity.projectId ||
      labels[EDGE_AGENT_LABEL] !== identity.agentId
    ) {
      throw new EdgeDockerError("EDGE_NOT_OWNED", "Container ownership labels do not match this deployment and agent");
    }
  }

  async stopAndRemoveOwned(containerName: string, identity: EdgeOwnedIdentity): Promise<void> {
    await this.assertOwned(containerName, identity);
    try {
      await this.manager.stop(containerName);
    } catch {
    }
    try {
      await this.manager.remove(containerName);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Container removal failed";
      throw new EdgeDockerError(
        "EDGE_CLEANUP_FAILED",
        boundErrorMessage(`Container cleanup failed: ${detail}`, "Container cleanup failed").slice(0, 500)
      );
    }
  }

  async listOwnedContainers(deploymentId: string): Promise<string[]> {
    requireUuid(deploymentId, "deployment id");
    let result: ExecResult;
    try {
      result = await this.run(
        this.config.dockerBinary,
        [
          "container", "ls", "--all",
          "--filter", `${EDGE_DEPLOYMENT_LABEL}=${deploymentId}`,
          "--format", "{{.Names}}",
        ],
        15_000
      );
    } catch {
      return [];
    }
    if (result.timedOut || result.aborted || result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => redactForLog(line).trim().replace(/^\//, ""))
      .filter((name) => EDGE_CONTAINER_NAME_PATTERN.test(name));
  }
}
