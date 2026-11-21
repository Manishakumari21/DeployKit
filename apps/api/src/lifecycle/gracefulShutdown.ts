import type { Server } from "node:http";
import type { Pool } from "pg";

export interface GracefulShutdownOptions {
  timeoutMs?: number;
  logger?: (
    level: "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>
  ) => void;
  onExit?: (code: number) => void;
  signals?: NodeJS.Signals[];
  processTarget?: NodeJS.Process;
}

export interface GracefulShutdownController {
  isShuttingDown: () => boolean;
  shutdown: (signal?: string) => Promise<void>;
  registerSignalHandlers: () => void;
  unregisterSignalHandlers: () => void;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

function resolveTimeout(overrideMs?: number): number {
  if (overrideMs !== undefined && Number.isSafeInteger(overrideMs) && overrideMs > 0) {
    return overrideMs;
  }
  const raw = process.env.DEPLOYKIT_SHUTDOWN_TIMEOUT_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

export function createGracefulShutdown(
  server: Server,
  pool: Pool,
  options: GracefulShutdownOptions = {}
): GracefulShutdownController {
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const logger =
    options.logger ??
    ((level, message, meta) => {
      const entry = {
        timestamp: new Date().toISOString(),
        level,
        component: "gracefulShutdown",
        message,
        ...meta,
      };
      if (level === "error") {
        console.error(JSON.stringify(entry));
      } else {
        console.log(JSON.stringify(entry));
      }
    });
  const onExit = options.onExit ?? ((code) => process.exit(code));
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  const proc = options.processTarget ?? process;

  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  const handlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];

  function isShuttingDown(): boolean {
    return shuttingDown;
  }

  async function shutdown(signal = "SIGTERM"): Promise<void> {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shuttingDown = true;
    logger("info", `${signal} received, initiating graceful shutdown`, { signal });

    shutdownPromise = (async () => {
      let forceTimer: NodeJS.Timeout | null = null;
      try {
        forceTimer = setTimeout(() => {
          logger("error", "Graceful shutdown timed out; forcing exit", { timeoutMs });
          onExit(1);
        }, timeoutMs);
        forceTimer.unref();

        // 1. Close idle keep-alive connections immediately so they don't hold the server open
        if (typeof server.closeIdleConnections === "function") {
          try {
            server.closeIdleConnections();
          } catch (idleErr) {
            logger("warn", "Failed to close idle connections", {
              error: idleErr instanceof Error ? idleErr.message : String(idleErr),
            });
          }
        }

        // 2. Close the HTTP server: stop accepting new requests, allow active requests to finish
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          logger("info", "HTTP server closed successfully");
        } catch (serverErr) {
          logger("error", "Error while closing HTTP server", {
            error: serverErr instanceof Error ? serverErr.message : String(serverErr),
          });
        }

        // 3. Close database pool: strictly executed after active requests have drained
        try {
          await pool.end();
          logger("info", "Database pool closed successfully");
        } catch (poolErr) {
          logger("error", "Error while closing database pool", {
            error: poolErr instanceof Error ? poolErr.message : String(poolErr),
          });
        }

        logger("info", "Graceful shutdown completed cleanly");
        if (forceTimer) {
          clearTimeout(forceTimer);
        }
        onExit(0);
      } catch (unexpectedError) {
        logger("error", "Unexpected error during graceful shutdown", {
          error:
            unexpectedError instanceof Error
              ? unexpectedError.message
              : String(unexpectedError),
        });
        if (forceTimer) {
          clearTimeout(forceTimer);
        }
        onExit(1);
      }
    })();

    return shutdownPromise;
  }

  function registerSignalHandlers(): void {
    for (const sig of signals) {
      const handler = () => {
        void shutdown(sig);
      };
      proc.on(sig, handler);
      handlers.push({ signal: sig, handler });
    }
  }

  function unregisterSignalHandlers(): void {
    for (const { signal, handler } of handlers) {
      proc.removeListener(signal, handler);
    }
    handlers.length = 0;
  }

  return {
    isShuttingDown,
    shutdown,
    registerSignalHandlers,
    unregisterSignalHandlers,
  };
}
