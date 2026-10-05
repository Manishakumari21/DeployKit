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
  aborted: boolean;
}

export interface StreamChunk {
  stream: "stdout" | "stderr";
  chunk: string;
}

export function runCommand(
  binary: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  onData?: (chunk: StreamChunk) => void
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ stdout: "", stderr: "Operation was aborted", code: 1, timedOut: false, aborted: true });
      return;
    }
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...(env ? { env } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c: Buffer) => {
      stdout = appendTail(stdout, c);
      try {
        onData?.({ stream: "stdout", chunk: c.toString() });
      } catch {
        // Never let a log hook break process execution.
      }
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = appendTail(stderr, c);
      try {
        onData?.({ stream: "stderr", chunk: c.toString() });
      } catch {
        // Never let a log hook break process execution.
      }
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      // If abort fired but process already exited, still report it.
      if (signal?.aborted) aborted = true;
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1, timedOut, aborted });
    });
  });
}

export async function runDockerStdout(binary: string, args: string[], timeoutMs = 30_000, signal?: AbortSignal): Promise<string> {
  let result: ExecResult;
  try {
    result = await runCommand(binary, args, timeoutMs, undefined, signal);
  } catch (e) {
    if (signal?.aborted) throw new Error("Docker command was aborted");
    throw new Error(e instanceof Error ? e.message : "Docker command failed");
  }
  if (result.aborted || signal?.aborted) throw new Error("Docker command was aborted");
  if (result.timedOut) throw new Error("Docker command timed out");
  if (result.code !== 0) throw new Error(result.stderr || `Docker exited with code ${result.code}`);
  return result.stdout;
}
