

import { EdgeAgentClient } from "./edgeAgentClient.js";
import { EdgeDockerRuntime } from "./edgeDocker.js";
import {
  runEdgeDeploymentOnce,
  type EdgeOutcome,
} from "./edgeExecutor.js";
import {
  EXIT_CONFIG,
  EXIT_PREFLIGHT,
  EXIT_REVOKED,
  parseEdgeAgentConfig,
  type EdgeAgentConfig,
  type EdgeLogLevel,
} from "./edgeAgentConfig.js";
import { redactForLog } from "./edgeJobSchema.js";
import {
  runCommand,
  type ExecResult,
} from "../infrastructure/process/dockerExec.js";

export const EXIT_OK = 0;
export const EXIT_FATAL = 1;

const MAX_BACKOFF_MS = 60_000;
const PREFLIGHT_TIMEOUT_MS = 15_000;

export class EdgeAgentPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeAgentPreflightError";
  }
}

export interface EdgeLogEntry {
  timestamp: string;
  level: EdgeLogLevel;
  component: "edge-agent";
  event: string;
  message?: string;
  [key: string]: unknown;
}

export type EdgeAgentClientLike = Pick<
  EdgeAgentClient,
  "claimJob" | "heartbeatJob" | "completeJob" | "failJob"
>;

export type EdgeAgentDockerLike = Pick<
  EdgeDockerRuntime,
  "pullImage" | "createAndStart" | "waitHealthy" | "stopAndRemoveOwned" | "listOwnedContainers"
>;

export interface EdgeAgentRunnerFactories {
  createClient?: (config: EdgeAgentConfig) => EdgeAgentClientLike;
  createDocker?: (config: EdgeAgentConfig) => EdgeAgentDockerLike;
  runFn?: (binary: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (entry: EdgeLogEntry) => void;
  now?: () => number;
}

const LEVEL_ORDER: Record<EdgeLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function boundField(value: unknown): unknown {
  if (typeof value === "string") return redactForLog(value).slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
  });
}

export class EdgeAgentRunner {
  private readonly config: EdgeAgentConfig;
  private readonly client: EdgeAgentClientLike;
  private readonly docker: EdgeAgentDockerLike;
  private readonly runFn: (binary: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly emit: (entry: EdgeLogEntry) => void;
  private readonly now: () => number;
  private stopping = false;
  private readonly shutdownController = new AbortController();
  private inFlight: AbortController | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env, factories: EdgeAgentRunnerFactories = {}) {

    this.config = parseEdgeAgentConfig(env);
    this.client =
      factories.createClient?.(this.config) ??
      new EdgeAgentClient({
        baseUrl: this.config.controlPlaneUrl,
        token: this.config.agentToken,
        requestTimeoutMs: this.config.requestTimeoutMs,
      });
    this.docker =
      factories.createDocker?.(this.config) ??
      new EdgeDockerRuntime({
        dockerBinary: this.config.dockerBinary,
        networkName: this.config.networkName,
        memoryBytes: this.config.memoryBytes,
        cpuLimit: this.config.cpuLimit,
        pidsLimit: this.config.pidsLimit,
        containerPort: this.config.containerPort,
        healthPath: this.config.healthPath,
        healthTimeoutMs: this.config.healthTimeoutMs,
      });
    this.runFn =
      factories.runFn ?? ((binary, args, timeoutMs) => runCommand(binary, args, timeoutMs));
    this.sleep = factories.sleep ?? defaultSleep;
    this.now = factories.now ?? Date.now;
    const sink = factories.log;
    this.emit = (entry) => {
      if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[this.config.logLevel]) return;
      if (sink !== undefined) {
        sink(entry);
        return;
      }
      const line = JSON.stringify(entry);
      if (entry.level === "error") console.error(line);
      else console.log(line);
    };
  }

  get agentConfig(): EdgeAgentConfig {
    return { ...this.config };
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  private log(level: EdgeLogLevel, event: string, fields: Record<string, unknown> = {}): void {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(key)) continue;
      if (/token|secret|password|credential|authorization|cookie|private_key/i.test(key)) {
        safe[key] = "[redacted]";
        continue;
      }
      const bounded = boundField(value);
      if (bounded !== undefined) safe[key] = bounded;
    }

    this.emit({
      timestamp: new Date(this.now()).toISOString(),
      level,
      component: "edge-agent",
      event,
      ...safe,
    });
  }

  async preflight(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new EdgeAgentPreflightError("Preflight cancelled");
    }
    let version: ExecResult;
    try {
      version = await this.runFn(
        this.config.dockerBinary,
        ["version", "--format", "{{.Server.Version}}"],
        PREFLIGHT_TIMEOUT_MS
      );
    } catch (error) {
      throw new EdgeAgentPreflightError(
        `Docker client/daemon unreachable: ${redactForLog(error instanceof Error ? error.message : "spawn failed").slice(0, 300)}`
      );
    }
    if (version.aborted || signal?.aborted) {
      throw new EdgeAgentPreflightError("Preflight cancelled");
    }
    if (version.timedOut || version.code !== 0) {
      throw new EdgeAgentPreflightError(
        `Docker client/daemon unreachable: ${redactForLog(version.stderr || `exit code ${version.code}`).slice(0, 300)}`
      );
    }
    const daemonVersion = version.stdout.trim().split(/\s+/)[0] || "unknown";
    let network: ExecResult;
    try {
      network = await this.runFn(
        this.config.dockerBinary,
        ["network", "inspect", this.config.networkName],
        PREFLIGHT_TIMEOUT_MS
      );
    } catch (error) {
      throw new EdgeAgentPreflightError(
        `Docker network check failed: ${redactForLog(error instanceof Error ? error.message : "spawn failed").slice(0, 300)}`
      );
    }
    if (network.aborted || signal?.aborted) {
      throw new EdgeAgentPreflightError("Preflight cancelled");
    }
    if (network.timedOut || network.code !== 0) {
      throw new EdgeAgentPreflightError(
        `Docker network '${this.config.networkName}' is not available: ` +
          "create it on this host (docker network create) or set DEPLOYKIT_EDGE_NETWORK to an existing network"
      );
    }
    this.log("info", "docker.preflight_ok", {
      daemonVersion: daemonVersion.slice(0, 64),
      network: this.config.networkName,
      dockerBinary: this.config.dockerBinary,
    });
  }

  private backoffDelay(consecutiveFailures: number): number {
    const grown = this.config.pollIntervalMs * 2 ** Math.min(consecutiveFailures, 5);
    return Math.min(grown, MAX_BACKOFF_MS);
  }

  async run(): Promise<number> {
    const startedAt = new Date(this.now()).toISOString();
    this.log("info", "agent.starting", {
      startedAt,
      controlPlaneHost: controlPlaneHostForLog(this.config.controlPlaneUrl),
      pollIntervalMs: this.config.pollIntervalMs,
      requestTimeoutMs: this.config.requestTimeoutMs,
      network: this.config.networkName,
    });
    try {
      await this.preflight(this.shutdownController.signal);
    } catch (error) {
      if (this.stopping || this.shutdownController.signal.aborted) {
        this.log("info", "agent.shutdown", { during: "preflight" });
        return EXIT_OK;
      }
      this.log("error", "docker.preflight_failed", {
        error: error instanceof Error ? error.message : "Preflight failed",
      });
      return EXIT_PREFLIGHT;
    }
    this.log("info", "agent.running", {});

    let consecutiveBackoff = 0;
    while (!this.stopping) {
      const iteration = new AbortController();
      this.inFlight = iteration;
      const linked =
        this.shutdownController.signal.aborted
          ? this.shutdownController.signal
          : AbortSignal.any([this.shutdownController.signal, iteration.signal]);
      let outcome: EdgeOutcome;
      try {
        outcome = await runEdgeDeploymentOnce(
          {
            client: this.client,
            docker: this.docker,
            agentId: this.config.agentId ?? undefined,
            heartbeatIntervalMs: this.config.heartbeatIntervalMs,
            executionTimeoutMs: this.config.executionTimeoutMs,
          },
          linked
        );
      } catch (error) {

        consecutiveBackoff += 1;
        this.log("error", "agent.iteration_failed", {
          error: redactForLog(error instanceof Error ? error.message : "Unknown error").slice(0, 300),
          backoffMs: this.backoffDelay(consecutiveBackoff),
        });
        this.inFlight = null;
        if (this.stopping) break;
        await this.sleep(this.backoffDelay(consecutiveBackoff), this.shutdownController.signal);
        continue;
      }
      this.inFlight = null;

      switch (outcome.result) {
        case "idle":
          this.log("debug", "agent.idle", {});
          consecutiveBackoff = 0;
          break;
        case "succeeded":
          consecutiveBackoff = 0;
          this.log("info", "agent.job_succeeded", {
            jobId: outcome.jobId,
            deploymentId: outcome.deploymentId,
          });
          break;
        case "failed":
          consecutiveBackoff = 0;
          this.log("warn", "agent.job_failed", {
            jobId: outcome.jobId,
            deploymentId: outcome.deploymentId,
            code: outcome.code,
          });
          break;
        case "blocked":
          consecutiveBackoff += 1;
          this.log("warn", "agent.job_blocked", {
            jobId: outcome.jobId,
            deploymentId: outcome.deploymentId,
            code: outcome.code,
            backoffMs: this.backoffDelay(consecutiveBackoff),
          });
          break;
        case "lease-lost":
          consecutiveBackoff = 0;
          this.log("warn", "agent.lease_lost", { code: outcome.code });
          break;
        case "revoked":
          this.log("error", "agent.revoked", {
            detail: "Credential rejected; rotation or re-enrollment is required. Stopping.",
          });
          return EXIT_REVOKED;
        case "cancelled":
          this.log("info", "agent.cancelled", {
            jobId: outcome.jobId,
            deploymentId: outcome.deploymentId,
          });
          consecutiveBackoff = 0;
          break;
        case "transient":
          consecutiveBackoff += 1;
          this.log("warn", "agent.transient", {
            code: outcome.code,
            backoffMs: this.backoffDelay(consecutiveBackoff),
          });
          break;
      }
      if (this.stopping) break;

      const waitMs =
        outcome.result === "transient" || outcome.result === "blocked"
          ? this.backoffDelay(consecutiveBackoff)
          : this.config.pollIntervalMs;
      await this.sleep(waitMs, this.shutdownController.signal);
    }
    this.log("info", "agent.shutdown", {});
    return EXIT_OK;
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    try {
      this.inFlight?.abort();
    } catch {
    }
    this.shutdownController.abort();
  }
}

function controlPlaneHostForLog(url: string): string {
  try {
    return new URL(url).host.slice(0, 255);
  } catch {
    return "[invalid]";
  }
}

export async function runEdgeAgentFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  factories: EdgeAgentRunnerFactories = {}
): Promise<number> {
  let runner: EdgeAgentRunner;
  try {
    runner = new EdgeAgentRunner(env, factories);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid configuration";
    const entry: EdgeLogEntry = {
      timestamp: new Date().toISOString(),
      level: "error",
      component: "edge-agent",
      event: "agent.config_invalid",
      message: redactForLog(message).slice(0, 500),
    };
    if (factories.log !== undefined) factories.log(entry);
    else console.error(JSON.stringify(entry));
    return EXIT_CONFIG;
  }
  const onShutdown = (): void => runner.stop();
  process.once("SIGTERM", onShutdown);
  process.once("SIGINT", onShutdown);
  try {
    return await runner.run();
  } catch (error) {
    const entry: EdgeLogEntry = {
      timestamp: new Date().toISOString(),
      level: "error",
      component: "edge-agent",
      event: "agent.fatal",
      message: redactForLog(error instanceof Error ? error.message : "Unknown error").slice(0, 500),
    };
    if (factories.log !== undefined) factories.log(entry);
    else console.error(JSON.stringify(entry));
    return EXIT_FATAL;
  } finally {
    process.removeListener("SIGTERM", onShutdown);
    process.removeListener("SIGINT", onShutdown);
  }
}
