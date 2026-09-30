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

export interface NginxGatewayRouterOptions {
  dockerBinary?: string;
  gatewayContainer?: string;
  gatewayHost?: string;
  routesDir?: string;
}

function shortRef(projectId: string): string {
  return projectId.replace(/-/g, "").slice(0, 8).toLowerCase();
}

export function renderProjectRoute(target: RouteTarget): string {
  validateRouteTarget(target);
  const ref = shortRef(target.projectId);
  const upstream = `dk_p${ref}`;
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
    `    server_name ${routeServerName(target.projectId)};`,
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
      throw new TrafficRouterError(
        "INVALID_GATEWAY",
        "Invalid gateway container name"
      );
    }
    const routesDir = (
      options.routesDir ??
      process.env.DEPLOYKIT_GATEWAY_ROUTES_DIR ??
      "/gateway-routes"
    ).trim();
    if (!routesDir || /[\0]/.test(routesDir)) {
      throw new TrafficRouterError(
        "INVALID_GATEWAY",
        "Invalid gateway routes directory"
      );
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
        throw new TrafficRouterError(
          "GATEWAY_COMMAND_FAILED",
          "Gateway command failed"
        );
      }
      throw error;
    }
  }

  private async reload(): Promise<void> {
    await this.execGateway(["nginx", "-t"]);
    await this.execGateway(["nginx", "-s", "reload"]);
  }

  async sync(target: RouteTarget): Promise<void> {
    validateRouteTarget(target);
    const content = renderProjectRoute(target);
    const filePath = this.routePath(target.projectId);
    const tmpPath = `${filePath}.tmp-${Date.now()}`;
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
    await this.reload();
  }

  async verifyRoute(target: RouteTarget, timeoutMs: number): Promise<void> {
    validateRouteTarget(target);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TrafficRouterError(
        "INVALID_TIMEOUT",
        "Route verification timeout must be positive"
      );
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
