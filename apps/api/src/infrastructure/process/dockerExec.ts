import { spawn } from "node:child_process";

export const MAX_OUTPUT_BYTES = 64 * 1024;

export function appendTail(current: string, chunk: Buffer | string, max = MAX_OUTPUT_BYTES): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next, "utf8") <= max) return next;
  return Buffer.from(next, "utf8").subarray(Buffer.length - max).toString("utf8");
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export function runCommand(
  binary: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...(env ? { env } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      stdout = appendTail(stdout, c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = appendTail(stderr, c);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1, timedOut });
    });
  });
}

export async function runDockerStdout(binary: string, args: string[], timeoutMs = 30_000): Promise<string> {
  let result: ExecResult;
  try {
    result = await runCommand(binary, args, timeoutMs);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Docker command failed");
  }
  if (result.timedOut) throw new Error("Docker command timed out");
  if (result.code !== 0) throw new Error(result.stderr || `Docker exited with code ${result.code}`);
  return result.stdout;
}
