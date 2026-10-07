import { mkdir, rename, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  runDocker,
  RuntimeManagerError,
} from "../runtime/dockerRuntimeManager.js";
import {
  routeServerName,
  validateRouteTarget,
  requestViaHost,
  TrafficRouterError,
  type RouteTarget,
  type TrafficRouter,
} from "./trafficRouter.js";
import { normalizeDomain } from "../../domains/domainName.js";

export interface NginxGatewayRouterOptions {
  dockerBinary?: string;
  gatewayContainer?: string;
  gatewayHost?: string;
  routesDir?: string;
}

function shortRef(projectId: string): string {
  return projectId.replace(/-/g, "").slice(0, 8).toLowerCase();
}

export function renderProjectRoute(
  target: RouteTarget,
  verifiedDomains: string[] = []
): string {
  validateRouteTarget(target);
  const domains = sanitizeVerifiedDomains(verifiedDomains);
  const ref = shortRef(target.projectId);
  const upstream = `dk_p${ref}`;
  const serverNames = [routeServerName(target.projectId), ...domains].join(" ");
  const lines = [
    "# deploykit-managed: DO NOT EDIT",
    `# project: ${target.projectId}`,
    `# release: ${target.releaseId}`,
    `# container: ${target.containerName}`,
    `upstream ${upstream} {`,
    `    server ${target.containerIp}:${target.containerPort} max_fails=3 fail_timeout=10s;`,
    "    keepalive 16;",
    "}",
    "server {",
    "    listen 80;",
    `    server_name ${serverNames};`,
    "    # Phase 11: ACME HTTP-01 reserved for a later step.",
    "    # No challenge is served yet; this block stays a 404.",
    "    location ^~ /.well-known/acme-challenge/ {",
    "        return 404;",
    "    }",
    "    location / {",
    `        proxy_pass http://${upstream};`,
    "        proxy_http_version 1.1;",
    "        proxy_set_header Host $host;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_connect_timeout 5s;",
    "        proxy_read_timeout 60s;",
    "    }",
    "}",
    "",
  ];
  return lines.join("\n");
}

// Single defensive gate for gateway input: only normalized DB hostnames
// become server_name values. Invalid entries are rejected loudly so a
// corrupt row can never silently enter nginx config.
export function sanitizeVerifiedDomains(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  const seen = new Set<string>();
  for (const raw of (input as unknown[]).slice(0, 50)) {
    if (typeof raw !== "string" || !raw) {
      throw new TrafficRouterError("INVALID_DOMAIN", "Invalid custom domain");
    }
    let normalized: string;
    try {
      normalized = normalizeDomain(raw);
    } catch {
      throw new TrafficRouterError("INVALID_DOMAIN", "Invalid custom domain");
    }
    seen.add(normalized);
  }
  return [...seen].sort();
}

export function parseProjectDomains(content: string): string[] {
  const line = /^\s*server_name\s+(.+?)\s*;/m.exec(content)?.[1];
  if (!line) return [];
  return line.split(/\s+/).filter(Boolean);
}

export function parseProjectRoute(
  projectId: string,
  content: string
): RouteTarget | null {
  const release = /^# release: (\S+)$/m.exec(content)?.[1];
  const container = /^# container: (\S+)$/m.exec(content)?.[1];
  const server = /^\s*server (\d{1,3}(?:\.\d{1,3}){3}):(\d+)\s/m.exec(content)?.slice(1);
  const project = /^# project: (\S+)$/m.exec(content)?.[1];
  if (!release || !container || !server || project !== projectId) {
    return null;
  }
  try {
    return validateRouteTarget({
      projectId,
      releaseId: release,
      containerName: container,
      containerIp: server[0],
      containerPort: Number(server[1]),
    });
  } catch {
    return null;
  }
}

export function routeFileName(projectId: string): string {
  return `dk-p${shortRef(projectId)}.conf`;
}

export class NginxGatewayRouter implements TrafficRouter {
  private readonly dockerBinary: string;
  private readonly gatewayContainer: string;
  private readonly gatewayHost: string;
  private readonly routesDir: string;

  constructor(options: NginxGatewayRouterOptions = {}) {
    const container = (
      options.gatewayContainer ??
      process.env.DEPLOYKIT_GATEWAY_CONTAINER ??
      "dk-gateway"
    ).trim();
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(container)) {
      throw new TrafficRouterError("INVALID_GATEWAY", "Invalid gateway container name");
    }
    const routesDir = (
      options.routesDir ??
      process.env.DEPLOYKIT_GATEWAY_ROUTES_DIR ??
      "/gateway-routes"
    ).trim();
    if (!routesDir || /[\0]/.test(routesDir)) {
      throw new TrafficRouterError("INVALID_GATEWAY", "Invalid gateway routes directory");
    }
    this.dockerBinary =
      options.dockerBinary ??
      process.env.DEPLOYKIT_DOCKER_BINARY ??
      "docker";
    this.gatewayContainer = container;
    this.gatewayHost = (
      options.gatewayHost ??
      process.env.DEPLOYKIT_GATEWAY_HOST ??
      "dk-gateway"
    ).trim();
    this.routesDir = routesDir;
  }

  private routePath(projectId: string): string {
    return path.join(this.routesDir, routeFileName(projectId));
  }

  private async execGateway(args: string[]): Promise<string> {
    try {
      return await runDocker(
        this.dockerBinary,
        ["container", "exec", this.gatewayContainer, ...args],
        30_000
      );
    } catch (error) {
      if (error instanceof RuntimeManagerError) {
        throw new TrafficRouterError("GATEWAY_COMMAND_FAILED", "Gateway command failed");
      }
      throw error;
    }
  }

  private async reload(): Promise<void> {
    await this.execGateway(["nginx", "-t"]);
    await this.execGateway(["nginx", "-s", "reload"]);
  }

  // Raw file content for backup/restore. Null when no route exists.
  async readRawConfig(projectId: string): Promise<string | null> {
    routeServerName(projectId);
    try {
      const content = await readFile(this.routePath(projectId), "utf8");
      if (content.length > 64 * 1024) return null;
      return content;
    } catch {
      return null;
    }
  }

  // Restore a previous known-good file (or remove when null), then reload.
  // Used only for rollback after a failed candidate projection.
  async restoreRawConfig(projectId: string, previous: string | null): Promise<void> {
    routeServerName(projectId);
    const filePath = this.routePath(projectId);
    if (previous === null) {
      await rm(filePath, { force: true });
    } else {
      const tmpPath = `${filePath}.tmp`;
      await mkdir(this.routesDir, { recursive: true });
      await writeFile(tmpPath, previous, { mode: 0o644 });
      await rename(tmpPath, filePath);
    }
    await this.reload();
  }

  async sync(target: RouteTarget, verifiedDomains: string[] = []): Promise<void> {
    validateRouteTarget(target);
    const content = renderProjectRoute(target, verifiedDomains);
    const filePath = this.routePath(target.projectId);
    // Deterministic tmp name scoped to the gateway file (no timestamps).
    const tmpPath = `${filePath}.tmp`;
    let previous: string | null = null;
    try {
      previous = await this.readRawConfig(target.projectId);
    } catch {
      previous = null;
    }
    try {
      await mkdir(this.routesDir, { recursive: true });
      await writeFile(tmpPath, content, { mode: 0o644 });
      await rename(tmpPath, filePath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw new TrafficRouterError(
        "GATEWAY_WRITE_FAILED",
        error instanceof Error
          ? `Gateway route write failed: ${error.message.slice(0, 200)}`
          : "Gateway route write failed"
      );
    }
    // Validate before treating the candidate as live. On failure the
    // previous known-good file is restored so the active route never breaks.
    try {
      await this.reload();
    } catch (error) {
      try {
        await this.restoreRawConfig(target.projectId, previous);
      } catch {
        // Best-effort restore; the original error stays authoritative.
      }
      if (error instanceof TrafficRouterError) throw error;
      throw new TrafficRouterError(
        "GATEWAY_RELOAD_FAILED",
        error instanceof Error
          ? `Gateway reload failed: ${error.message.slice(0, 200)}`
          : "Gateway reload failed"
      );
    }
  }

  async verifyRoute(target: RouteTarget, timeoutMs: number): Promise<void> {
    validateRouteTarget(target);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TrafficRouterError("INVALID_TIMEOUT", "Route verification timeout must be positive");
    }
    const deadline = Date.now() + timeoutMs;
    let lastError = "No response";
    while (Date.now() < deadline) {
      try {
        const { status } = await requestViaHost(
          this.gatewayHost,
          80,
          routeServerName(target.projectId)
        );
        if (status >= 200 && status < 400) {
          return;
        }
        lastError = `HTTP ${status}`;
      } catch (error) {
        lastError =
          error instanceof Error ? error.message.slice(0, 200) : "Route check failed";
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new TrafficRouterError(
      "ROUTE_NOT_READY",
      `Gateway does not serve the active release: ${lastError.slice(0, 200)}`
    );
  }

  async remove(projectId: string): Promise<void> {
    routeServerName(projectId);
    await rm(this.routePath(projectId), { force: true });
    await this.reload();
  }

  async activeTarget(projectId: string): Promise<RouteTarget | null> {
    routeServerName(projectId);
    let content: string;
    try {
      content = await readFile(this.routePath(projectId), "utf8");
    } catch {
      return null;
    }
    if (content.length > 64 * 1024) {
      return null;
    }
    return parseProjectRoute(projectId, content);
  }
}
