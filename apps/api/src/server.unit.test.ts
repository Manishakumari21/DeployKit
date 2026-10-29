import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

const API_ROOT = path.resolve(__dirname, "..");
const TSX_CLI = path.join(API_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const STARTUP_TIMEOUT_MS = 30_000;

async function assertCleanShutdown(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  const child = spawn(process.execPath, [TSX_CLI, "src/server.ts"], {
    cwd: API_ROOT,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let started = false;
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("DeployKit API running on port")) started = true;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!started && Date.now() < startupDeadline) {
    if (child.exitCode !== null) {
      assert.fail(`server exited early (${child.exitCode}): ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(started, `server never reported startup: ${output}`);

  child.kill(signal);
  const [code, sig] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  assert.equal(sig, null, `server terminated by ${sig}, not a clean exit: ${output}`);
  assert.equal(code, 0, `server exited ${code} on ${signal}, expected 0: ${output}`);
}

test("server exits cleanly with code 0 on SIGTERM", async () => {
  await assertCleanShutdown("SIGTERM");
});

test("server exits cleanly with code 0 on SIGINT", async () => {
  await assertCleanShutdown("SIGINT");
});
