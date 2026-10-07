import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../infrastructure/process/dockerExec.js";
import {
  getOptionalRegistryConfig,
  RegistryConfigError,
  type RegistryConfig,
} from "../infrastructure/registry/registryConfig.js";
import { cleanupOrphanedContainers, cleanupStaleCheckoutWorkspaces } from "./orphanCleanup.js";

export const DEFAULT_BUILDER_NAME = "deploykit-builder";
export const DEFAULT_BUILDX_CONFIG_DIR = "/tmp/deploykit-buildx";

export class BootstrapError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
  }
}

export interface BootstrapResult {
  dockerBinary: string;
  builderName: string;
  buildxConfigDir: string;
  registryHost: string | null;
}

export type WorkerLifecycleStage =
  | "STARTING"
  | "BOOTSTRAPPING"
  | "READY"
  | "PROCESSING";

function lifecycleEvent(stage: WorkerLifecycleStage, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: stage === "STARTING" || stage === "BOOTSTRAPPING" ? "info" : "info",
      event: `worker.${stage.toLowerCase()}`,
      stage,
      ...fields,
    })
  );
}

function dockerBinary(): string {
  const v = (process.env.DEPLOYKIT_DOCKER_BINARY ?? "docker").trim();
  if (!v) throw new BootstrapError("INVALID_DOCKER_BINARY", "DEPLOYKIT_DOCKER_BINARY must not be empty");
  return v;
}

function builderName(): string {
  const v = (process.env.DEPLOYKIT_BUILDER_NAME ?? DEFAULT_BUILDER_NAME).trim();
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(v)) {
    throw new BootstrapError("INVALID_BUILDER_NAME", `Invalid builder name: ${v}`);
  }
  return v;
}

function buildxConfigDir(): string {
  const v = (process.env.BUILDX_CONFIG ?? process.env.DEPLOYKIT_BUILDX_CONFIG ?? DEFAULT_BUILDX_CONFIG_DIR).trim();
  if (!v || v.includes("\0")) {
    throw new BootstrapError("INVALID_BUILDX_CONFIG", "Invalid BUILDX_CONFIG directory");
  }
  return v;
}

function bootstrapEnv(configDir: string): NodeJS.ProcessEnv {
  return { ...process.env, BUILDX_CONFIG: configDir };
}

export const BASE_BUILDKITD_TOML = `debug = false

insecure-entitlements = []

[log]
  level = "info"
  format = "json"

[worker.oci]
  max-parallelism = 2
`;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Desired buildkitd.toml for the deterministic builder. When a local insecure
// (plain-HTTP) registry is configured, buildkitd needs an explicit per-host
// `http = true` stanza — it never falls back to HTTP for non-loopback hosts.
// TLS registries need no stanza. The host is already strictly validated by
// registryConfig (lowercase host[:port], no whitespace/quotes), but we refuse
// to interpolate anything containing a quote or newline regardless.
export function desiredBuildkitdToml(registry: RegistryConfig | null): string {
  if (!registry || !registry.insecure) {
    return BASE_BUILDKITD_TOML;
  }
  const host = registry.registryHost;
  if (/["'\r\n]/.test(host)) {
    throw new BootstrapError("REGISTRY_CONFIG_INVALID", "Registry host cannot be rendered into BuildKit config");
  }
  return `${BASE_BUILDKITD_TOML}\n[registry."${host}"]\n  http = true\n`;
}

export function buildkitdTomlPath(configDir: string): string {
  return path.join(configDir, "buildkitd.toml");
}

export function buildkitdMarkerPath(configDir: string): string {
  return path.join(configDir, "deploykit-builder.buildkitd.sha256");
}

function runtimeNetworkName(): string {
  const v = (process.env.DEPLOYKIT_RUNTIME_NETWORK ?? "deploykit-runtime").trim();
  if (!v) throw new BootstrapError("INVALID_RUNTIME_NETWORK", "DEPLOYKIT_RUNTIME_NETWORK must not be empty");
  return v;
}

function loadRegistryConfig(): RegistryConfig | null {
  try {
    return getOptionalRegistryConfig();
  } catch (e) {
    throw new BootstrapError(
      "REGISTRY_CONFIG_INVALID",
      e instanceof Error ? `Invalid registry configuration: ${e.message.slice(0, 300)}` : "Invalid registry configuration"
    );
  }
}

async function checkRegistryReachable(host: string, timeoutMs = 5_000): Promise<void> {
  const { hostname, port } = parseRegistryHost(host);
  await new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    const done = (err?: Error) => {
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done());
    socket.once("timeout", () => done(new Error(`Registry ${host} connection timed out`)));
    socket.once("error", (e) => done(e));
    socket.connect(port, hostname);
  });
}

function parseRegistryHost(host: string): { hostname: string; port: number } {
  const trimmed = host.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0 && /^[0-9]+$/.test(trimmed.slice(lastColon + 1))) {
    const port = Number(trimmed.slice(lastColon + 1));
    if (port < 1 || port > 65535) throw new BootstrapError("INVALID_REGISTRY_HOST", `Invalid registry port: ${host}`);
    return { hostname: trimmed.slice(0, lastColon), port };
  }
  return { hostname: trimmed, port: 5000 };
}

async function workerContainerNetworks(
  binary: string,
  env: NodeJS.ProcessEnv
): Promise<{ networks: string[]; discovered: boolean }> {
  const fallback = [runtimeNetworkName()];
  try {
    const result = await runCommand(binary, ["inspect", os.hostname()], 15_000, env);
    if (result.code !== 0) return { networks: fallback, discovered: false };
    const parsed = JSON.parse(result.stdout) as Array<{ NetworkSettings?: { Networks?: Record<string, unknown> } }>;
    const names = Object.keys(parsed[0]?.NetworkSettings?.Networks ?? {});
    if (!names.length) return { networks: fallback, discovered: false };
    return { networks: names, discovered: true };
  } catch {
    return { networks: fallback, discovered: false };
  }
}

async function builderContainerName(
  binary: string,
  builder: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  try {
    const result = await runCommand(
      binary,
      ["ps", "--filter", `name=buildx_buildkit_${builder}`, "--format", "{{.Names}}"],
      15_000,
      env
    );
    if (result.code !== 0) return null;
    const first = result.stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0];
    return first ?? null;
  } catch {
    return null;
  }
}

async function containerNetworks(
  binary: string,
  container: string,
  env: NodeJS.ProcessEnv
): Promise<string[]> {
  const result = await runCommand(binary, ["container", "inspect", container], 15_000, env);
  if (result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as { NetworkSettings?: { Networks?: Record<string, unknown> } };
    return Object.keys(parsed?.NetworkSettings?.Networks ?? {});
  } catch {
    return [];
  }
}

async function ensureBuilderNetworks(
  binary: string,
  builder: string,
  env: NodeJS.ProcessEnv,
  registry: RegistryConfig | null
): Promise<string[]> {
  const { networks: targets, discovered } = await workerContainerNetworks(binary, env);
  if (!discovered) {
    lifecycleEvent("BOOTSTRAPPING", { step: "builder_network_fallback", networks: targets });
  }
  const container = await builderContainerName(binary, builder, env);
  if (!container) {
    if (registry) {
      throw new BootstrapError("BUILDER_CONTAINER_NOT_FOUND", `Builder container for ${builder} not found`);
    }
    lifecycleEvent("BOOTSTRAPPING", { step: "builder_network_skipped", reason: "builder container not found" });
    return [];
  }
  const attached = new Set(await containerNetworks(binary, container, env));
  const connected: string[] = [];
  for (const network of targets) {
    if (attached.has(network)) continue;
    const result = await runCommand(binary, ["network", "connect", network, container], 30_000, env);
    if (result.code !== 0 && !/already/i.test(result.stderr)) {
      const message = `Failed to attach builder ${builder} to network ${network}: ${(result.stderr || `exit ${result.code}`).slice(0, 300)}`;
      if (registry) {
        throw new BootstrapError("BUILDER_NETWORK_FAILED", message);
      }
      lifecycleEvent("BOOTSTRAPPING", { step: "builder_network_warning", network, error: message.slice(0, 200) });
      continue;
    }
    connected.push(network);
  }
  return connected;
}

export async function bootstrapWorker(): Promise<BootstrapResult> {
  const binary = dockerBinary();
  const builder = builderName();
  const configDir = buildxConfigDir();

  lifecycleEvent("STARTING", { dockerBinary: binary, builder, buildxConfigDir: configDir });

  await mkdir(configDir, { recursive: true });
  // Fail closed: child buildx commands must use this controlled directory,
  // never an accidental container-home default.
  process.env.BUILDX_CONFIG = configDir;
  const env = bootstrapEnv(configDir);

  // Fail fast on invalid registry configuration before touching Docker.
  const registry = loadRegistryConfig();
  const desiredToml = desiredBuildkitdToml(registry);
  const desiredSha = sha256Hex(desiredToml);
  const tomlPath = buildkitdTomlPath(configDir);
  const markerPath = buildkitdMarkerPath(configDir);

  lifecycleEvent("BOOTSTRAPPING", { step: "docker_cli" });
  try {
    const cli = await runCommand(binary, ["--version"], 15_000, env);
    if (cli.code !== 0) throw new Error(cli.stderr || "docker --version failed");
  } catch (e) {
    throw new BootstrapError("DOCKER_CLI_MISSING", e instanceof Error ? `Docker CLI unavailable: ${e.message.slice(0, 300)}` : "Docker CLI unavailable");
  }

  lifecycleEvent("BOOTSTRAPPING", { step: "docker_daemon" });
  try {
    const info = await runCommand(binary, ["info"], 30_000, env);
    if (info.code !== 0) throw new Error(info.stderr.slice(0, 500) || "docker info failed");
  } catch (e) {
    if (e instanceof BootstrapError) throw e;
    throw new BootstrapError("DOCKER_DAEMON_UNREACHABLE", e instanceof Error ? `Docker daemon unreachable: ${e.message.slice(0, 300)}` : "Docker daemon unreachable");
  }

  lifecycleEvent("BOOTSTRAPPING", { step: "buildx" });
  try {
    const bx = await runCommand(binary, ["buildx", "version"], 15_000, env);
    if (bx.code !== 0) throw new Error(bx.stderr.slice(0, 500) || "docker buildx version failed");
  } catch (e) {
    if (e instanceof BootstrapError) throw e;
    throw new BootstrapError("BUILDX_UNAVAILABLE", e instanceof Error ? `Buildx unavailable: ${e.message.slice(0, 300)}` : "Buildx unavailable");
  }

  lifecycleEvent("BOOTSTRAPPING", { step: "builder_ensure", builder });
  const createBuilder = async (): Promise<void> => {
    await writeFile(tomlPath, desiredToml, "utf8");
    const created = await runCommand(
      binary,
      ["buildx", "create", "--name", builder, "--driver", "docker-container", "--buildkitd-config", tomlPath, "--bootstrap"],
      180_000,
      env
    );
    if (created.code !== 0) {
      throw new BootstrapError(
        "BUILDER_CREATE_FAILED",
        `Failed to create builder ${builder}: ${created.stderr.slice(0, 500) || `exit ${created.code}`}`
      );
    }
    await writeFile(markerPath, `${desiredSha}\n`, "utf8");
  };
  const inspectExisting = await runCommand(binary, ["buildx", "inspect", builder], 30_000, env);
  if (inspectExisting.code !== 0) {
    lifecycleEvent("BOOTSTRAPPING", { step: "builder_create", builder, reason: "missing" });
    await createBuilder();
  } else {
    let marker: string | null = null;
    try {
      marker = (await readFile(markerPath, "utf8")).trim();
    } catch {
      marker = null;
    }
    if (marker !== desiredSha) {
      lifecycleEvent("BOOTSTRAPPING", { step: "builder_recreate", builder, reason: "buildkitd config changed" });
      const removed = await runCommand(binary, ["buildx", "rm", builder], 60_000, env);
      if (removed.code !== 0) {
        throw new BootstrapError(
          "BUILDER_RECREATE_FAILED",
          `Failed to remove stale builder ${builder}: ${removed.stderr.slice(0, 500) || `exit ${removed.code}`}`
        );
      }
      await createBuilder();
    } else {
      lifecycleEvent("BOOTSTRAPPING", { step: "builder_reused", builder });
    }
  }

  // Bootstrap and verify operational. Uses only flags supported by Buildx 0.37.1.
  lifecycleEvent("BOOTSTRAPPING", { step: "builder_bootstrap", builder });
  const bootstrapped = await runCommand(binary, ["buildx", "inspect", "--builder", builder, "--bootstrap"], 120_000, env);
  if (bootstrapped.code !== 0 || bootstrapped.timedOut || bootstrapped.aborted) {
    throw new BootstrapError(
      "BUILDER_NOT_READY",
      `Builder ${builder} did not become ready: ${(bootstrapped.stderr || "inspect failed").slice(0, 500)}`
    );
  }

  if (registry) {
    lifecycleEvent("BOOTSTRAPPING", { step: "registry", registryHost: registry.registryHost });
    try {
      await checkRegistryReachable(registry.registryHost, 10_000);
    } catch (e) {
      throw new BootstrapError(
        "REGISTRY_UNREACHABLE",
        e instanceof Error ? `Registry ${registry.registryHost} unreachable: ${e.message.slice(0, 300)}` : `Registry ${registry.registryHost} unreachable`
      );
    }
  }

  // Attach the builder container to the worker's networks so BuildKit pushes
  // can reach registries on Compose networks (e.g. deploykit-registry on the
  // default network). Post-creation `network connect` is idempotent and
  // preserves the builder's build cache. Fatal in registry mode (push would
  // fail); advisory otherwise.
  lifecycleEvent("BOOTSTRAPPING", { step: "builder_network", builder });
  const attachedNetworks = await ensureBuilderNetworks(binary, builder, env, registry);
  lifecycleEvent("BOOTSTRAPPING", { step: "builder_network_done", builder, networks: attachedNetworks });

  // Scoped orphan sweep: DeployKit-owned temp workspaces and non-running
  // DeployKit-owned containers only. Never touches running releases or
  // unrelated Docker resources. Best-effort; never fails bootstrap.
  lifecycleEvent("BOOTSTRAPPING", { step: "orphan_cleanup" });
  try {
    const [workspaces, containers] = await Promise.all([
      cleanupStaleCheckoutWorkspaces(),
      cleanupOrphanedContainers(binary),
    ]);
    lifecycleEvent("BOOTSTRAPPING", { step: "orphan_cleanup_done", workspaces, containers });
  } catch {
    // Best-effort.
  }

  lifecycleEvent("READY", { builder, buildxConfigDir: configDir, registryHost: registry?.registryHost ?? null });
  return { dockerBinary: binary, builderName: builder, buildxConfigDir: configDir, registryHost: registry?.registryHost ?? null };
}
