import { Socket } from "node:net";

export interface RouteTarget {
  projectId: string;
  releaseId: string;
  containerName: string;
  containerIp: string;
  containerPort: number;
}

export interface TrafficRouter {
  sync(target: RouteTarget): Promise<void>;
  verifyRoute(target: RouteTarget, timeoutMs: number): Promise<void>;
  remove(projectId: string): Promise<void>;
  activeTarget(projectId: string): Promise<RouteTarget | null>;
}

export class TrafficRouterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TrafficRouterError";
    this.code = code;
  }
}

export function validateRouteTarget(target: RouteTarget): RouteTarget {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      target.projectId
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      target.releaseId
    )
  ) {
    throw new TrafficRouterError("INVALID_ROUTE_TARGET", "Route target requires valid project and release ids");
  }
  if (
    !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(target.containerName)
  ) {
    throw new TrafficRouterError("INVALID_ROUTE_TARGET", "Invalid route target container");
  }
  if (
    !/^(\d{1,3}\.){3}\d{1,3}$/.test(target.containerIp) ||
    target.containerIp
      .split(".")
      .some((octet) => Number(octet) > 255)
  ) {
    throw new TrafficRouterError("INVALID_ROUTE_TARGET", "Invalid route target address");
  }
  if (
    !Number.isInteger(target.containerPort) ||
    target.containerPort < 1 ||
    target.containerPort > 65535
  ) {
    throw new TrafficRouterError("INVALID_ROUTE_TARGET", "Invalid route target port");
  }
  return target;
}

export function routeServerName(projectId: string): string {
  const short = projectId.replace(/-/g, "").slice(0, 8).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(short)) {
    throw new TrafficRouterError("INVALID_PROJECT", "Invalid project id for routing");
  }
  return `dk-p${short}.deploykit.local`;
}

export class UnconfiguredTrafficRouter implements TrafficRouter {  async sync(_target: RouteTarget): Promise<void> {
    throw new Error("TRAFFIC_ROUTER_NOT_CONFIGURED");
  }

  async verifyRoute(_target: RouteTarget,
    _timeoutMs: number): Promise<void> {
    throw new Error("TRAFFIC_ROUTER_NOT_CONFIGURED");
  }

  async remove(_projectId: string): Promise<void> {
    throw new Error("TRAFFIC_ROUTER_NOT_CONFIGURED");
  }

  async activeTarget(_projectId: string): Promise<RouteTarget | null> {
    throw new Error("TRAFFIC_ROUTER_NOT_CONFIGURED");
  }
}

export async function requestViaHost(
  host: string,
  port: number,
  serverName: string,
  requestTimeoutMs = 5_000
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new TrafficRouterError("ROUTE_CHECK_TIMEOUT", "Route check timed out"));
    }, requestTimeoutMs);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.connect(port, host, () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${serverName}\r\nConnection: close\r\n\r\n`
      );
    });
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 64 * 1024) {
        clearTimeout(timer);
        socket.destroy();
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const headEnd = data.indexOf("\r\n\r\n");
      const head = headEnd === -1 ? data : data.slice(0, headEnd);
      const body = headEnd === -1 ? "" : data.slice(headEnd + 4);
      resolve({
        status: Number(/HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0),
        body,
      });
    });
  });
}
