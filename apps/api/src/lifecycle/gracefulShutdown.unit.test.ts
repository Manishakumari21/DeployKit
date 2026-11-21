import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { createGracefulShutdown } from "./gracefulShutdown.js";

function createMockServer(options: {
  closeDelayMs?: number;
  closeError?: Error | null;
  onClose?: () => void;
} = {}) {
  let closed = false;
  let idleClosed = false;
  const server = {
    closeIdleConnections: () => {
      idleClosed = true;
    },
    close: (cb: (err?: Error) => void) => {
      closed = true;
      options.onClose?.();
      if (options.closeDelayMs) {
        setTimeout(() => cb(options.closeError ?? undefined), options.closeDelayMs);
      } else {
        cb(options.closeError ?? undefined);
      }
      return server as unknown as Server;
    },
    isClosed: () => closed,
    isIdleClosed: () => idleClosed,
  };
  return server;
}

function createMockPool(options: {
  endDelayMs?: number;
  endError?: Error | null;
  onEnd?: () => void;
} = {}) {
  let ended = false;
  const pool = {
    end: async () => {
      ended = true;
      options.onEnd?.();
      if (options.endDelayMs) {
        await new Promise((r) => setTimeout(r, options.endDelayMs));
      }
      if (options.endError) {
        throw options.endError;
      }
    },
    isEnded: () => ended,
  };
  return pool;
}

test("graceful shutdown executes in strict order: idle connections -> server.close -> pool.end -> exit(0)", async () => {
  const callOrder: string[] = [];
  const server = createMockServer({
    onClose: () => callOrder.push("server.close"),
  });
  const pool = createMockPool({
    onEnd: () => callOrder.push("pool.end"),
  });

  let exitCode: number | null = null;
  const controller = createGracefulShutdown(
    server as unknown as Server,
    pool as unknown as Pool,
    {
      timeoutMs: 1000,
      logger: () => {},
      onExit: (code) => {
        exitCode = code;
        callOrder.push(`exit(${code})`);
      },
    }
  );

  assert.equal(controller.isShuttingDown(), false);
  await controller.shutdown("SIGTERM");

  assert.equal(controller.isShuttingDown(), true);
  assert.equal(server.isIdleClosed(), true);
  assert.equal(server.isClosed(), true);
  assert.equal(pool.isEnded(), true);
  assert.equal(exitCode, 0);
  assert.deepEqual(callOrder, ["server.close", "pool.end", "exit(0)"]);
});

test("graceful shutdown waits for in-flight requests before ending database pool", async () => {
  const timeline: string[] = [];
  const server = createMockServer({
    closeDelayMs: 50,
    onClose: () => timeline.push("server.closing"),
  });
  const pool = createMockPool({
    onEnd: () => timeline.push("pool.ending"),
  });

  let exitCode: number | null = null;
  const controller = createGracefulShutdown(
    server as unknown as Server,
    pool as unknown as Pool,
    {
      timeoutMs: 2000,
      logger: () => {},
      onExit: (code) => {
        exitCode = code;
        timeline.push("exit");
      },
    }
  );

  await controller.shutdown("SIGINT");

  assert.equal(exitCode, 0);
  assert.deepEqual(timeline, ["server.closing", "pool.ending", "exit"]);
});

test("graceful shutdown is idempotent when invoked concurrently or multiple times", async () => {
  let serverCloseCount = 0;
  let poolEndCount = 0;
  let exitCalls = 0;

  const server = {
    closeIdleConnections: () => {},
    close: (cb: (err?: Error) => void) => {
      serverCloseCount++;
      setTimeout(cb, 20);
      return server as unknown as Server;
    },
  };
  const pool = {
    end: async () => {
      poolEndCount++;
    },
  };

  const controller = createGracefulShutdown(
    server as unknown as Server,
    pool as unknown as Pool,
    {
      timeoutMs: 1000,
      logger: () => {},
      onExit: () => {
        exitCalls++;
      },
    }
  );

  // Invoke concurrently from SIGTERM and SIGINT
  await Promise.all([
    controller.shutdown("SIGTERM"),
    controller.shutdown("SIGINT"),
    controller.shutdown("SIGTERM"),
  ]);

  assert.equal(serverCloseCount, 1, "server.close must only be called once");
  assert.equal(poolEndCount, 1, "pool.end must only be called once");
  assert.equal(exitCalls, 1, "onExit must only be called once");
});

test("server close error does not skip closing database pool", async () => {
  const callOrder: string[] = [];
  const server = createMockServer({
    closeError: new Error("simulated server close error"),
    onClose: () => callOrder.push("server.close"),
  });
  const pool = createMockPool({
    onEnd: () => callOrder.push("pool.end"),
  });

  let exitCode: number | null = null;
  const controller = createGracefulShutdown(
    server as unknown as Server,
    pool as unknown as Pool,
    {
      timeoutMs: 1000,
      logger: () => {},
      onExit: (code) => {
        exitCode = code;
        callOrder.push(`exit(${code})`);
      },
    }
  );

  await controller.shutdown("SIGTERM");

  assert.equal(pool.isEnded(), true, "pool must still be ended when server close errors");
  assert.equal(exitCode, 0, "shutdown still exits cleanly after logging step error");
  assert.deepEqual(callOrder, ["server.close", "pool.end", "exit(0)"]);
});

test("database pool end error does not crash shutdown process", async () => {
  const server = createMockServer();
  const pool = createMockPool({
    endError: new Error("simulated pool.end error"),
  });

  let exitCode: number | null = null;
  const controller = createGracefulShutdown(
    server as unknown as Server,
    pool as unknown as Pool,
    {
      timeoutMs: 1000,
      logger: () => {},
      onExit: (code) => {
        exitCode = code;
      },
    }
  );

  await controller.shutdown("SIGTERM");
  assert.equal(server.isClosed(), true);
  assert.equal(pool.isEnded(), true);
  assert.equal(exitCode, 0);
});

test("shutdown timeout forces process exit(1) when server close hangs", async () => {
  // A server that hangs indefinitely and never invokes its close callback
  const hangingServer = {
    closeIdleConnections: () => {},
    close: () => hangingServer as unknown as Server,
  };
  const pool = createMockPool();

  let exitCode: number | null = null;
  await new Promise<void>((resolve) => {
    const controller = createGracefulShutdown(
      hangingServer as unknown as Server,
      pool as unknown as Pool,
      {
        timeoutMs: 50, // Short timeout for test
        logger: () => {},
        onExit: (code) => {
          exitCode = code;
          resolve();
        },
      }
    );
    void controller.shutdown("SIGTERM");
  });

  assert.equal(exitCode, 1, "forced termination must exit with code 1");
  assert.equal(pool.isEnded(), false, "pool.end is not reached because server was still hung");
});

test("signal handlers register and trigger shutdown on mock process", async () => {
  const mockProcess = new EventEmitter() as NodeJS.Process;
  const server = createMockServer();
  const pool = createMockPool();

  let exitCode: number | null = null;
  const controller = createGracefulShutdown(
    server as unknown as Server,
    pool as unknown as Pool,
    {
      timeoutMs: 1000,
      logger: () => {},
      processTarget: mockProcess,
      signals: ["SIGTERM", "SIGINT"],
      onExit: (code) => {
        exitCode = code;
      },
    }
  );

  controller.registerSignalHandlers();
  assert.equal(mockProcess.listenerCount("SIGTERM"), 1);
  assert.equal(mockProcess.listenerCount("SIGINT"), 1);

  // Emit SIGTERM on mock process
  mockProcess.emit("SIGTERM");

  // Wait for shutdown promise to settle
  await controller.shutdown("SIGTERM");

  assert.equal(exitCode, 0);
  assert.equal(server.isClosed(), true);

  controller.unregisterSignalHandlers();
  assert.equal(mockProcess.listenerCount("SIGTERM"), 0);
  assert.equal(mockProcess.listenerCount("SIGINT"), 0);
});
