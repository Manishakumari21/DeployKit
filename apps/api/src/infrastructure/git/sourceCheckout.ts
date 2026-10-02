import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_ALLOWED_HOSTS = ["github.com"];

const CHECKOUT_ROOT =
  process.env.DEPLOYKIT_CHECKOUT_ROOT ??
  path.join(os.tmpdir(), "deploykit-checkouts");

const CHECKOUT_TIMEOUT_MS = Number(
  process.env.DEPLOYKIT_CHECKOUT_TIMEOUT_MS ??
    DEFAULT_TIMEOUT_MS
);

export interface SourceCheckoutOptions {
  repositoryUrl: string;
  branch: string;
  targetCommitSha?: string | null;
  authToken?: string | null;
}

export interface SourceCheckoutResult {
  workspace: string;
  commitSha: string;
}

export class SourceCheckoutError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SourceCheckoutError";
    this.code = code;
  }
}

function allowedHosts(): Set<string> {
  const configured =
    process.env.DEPLOYKIT_ALLOWED_GIT_HOSTS ??
    DEFAULT_ALLOWED_HOSTS.join(",");

  return new Set(
    configured
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function validateRepositoryUrl(repositoryUrl: string): URL {
  let url: URL;

  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new SourceCheckoutError("INVALID_REPOSITORY_URL", "Repository URL is not a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new SourceCheckoutError("UNSUPPORTED_REPOSITORY_PROTOCOL", "Only HTTPS Git repositories are supported");
  }

  if (url.username || url.password) {
    throw new SourceCheckoutError("REPOSITORY_CREDENTIALS_FORBIDDEN", "Credentials must not be embedded in repository URLs");
  }

  if (url.port && url.port !== "443") {
    throw new SourceCheckoutError("UNSUPPORTED_REPOSITORY_PORT", "Only the default HTTPS port is supported");
  }

  if (url.search || url.hash) {
    throw new SourceCheckoutError("INVALID_REPOSITORY_URL", "Repository URL must not contain query parameters or fragments");
  }

  const hostname = url.hostname.toLowerCase();

  if (!allowedHosts().has(hostname)) {
    throw new SourceCheckoutError("REPOSITORY_HOST_NOT_ALLOWED", `Git host is not allowed: ${hostname}`);
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean);

  if (segments.length < 2) {
    throw new SourceCheckoutError("INVALID_REPOSITORY_URL", "Repository URL must contain an owner and repository");
  }

  return url;
}
export function validateBranch(branch: string): string {
  const value = branch.trim();

  if (!value) {
    throw new SourceCheckoutError("INVALID_BRANCH", "Branch must not be empty");
  }

  if (value.length > 255) {
    throw new SourceCheckoutError("INVALID_BRANCH", "Branch is too long");
  }

  if (/[\u0000-\u001f\u007f\s]/.test(value)) {
    throw new SourceCheckoutError("INVALID_BRANCH", "Branch contains invalid characters");
  }

  if (
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("\\")
  ) {
    throw new SourceCheckoutError("INVALID_BRANCH", "Branch contains invalid Git ref syntax");
  }

  return value;
}

function gitEnvironment(authToken?: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ASKPASS: "/bin/false",
    LC_ALL: "C",
  };
  if (authToken !== undefined && authToken !== null) {
    validateAuthToken(authToken);
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: bearer ${authToken}`;
  }
  return env;
}

function validateAuthToken(authToken: string): void {
  if (/[\r\n\0]/.test(authToken) || authToken.length === 0 || authToken.length > 4096) {
    throw new SourceCheckoutError("INVALID_AUTH_TOKEN", "Invalid Git credential");
  }
}

function baseGitConfig(): string[] {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "fetch.fsckObjects=true",
  ];
}

export function __gitEnvironmentForTest(authToken?: string | null): NodeJS.ProcessEnv {
  return gitEnvironment(authToken ?? null);
}

export function __gitArgvForTest(kind: "clone" | "fetch" | "rev-parse"): string[] {
  const gitBase = baseGitConfig();
  if (kind === "clone") {
    return [...gitBase, "clone", "--depth", "1", "--branch", "main", "<url>", "<workspace>"];
  }
  if (kind === "fetch") {
    return [...gitBase, "fetch", "--depth", "1", "origin", "<sha>"];
  }
  return [...gitBase, "rev-parse", "HEAD"];
}

async function runGit(
  args: string[],
  cwd?: string,
  authToken?: string | null
) {
  try {
    return await execFileAsync(
      "git",
      args,
      {
        cwd,
        env: gitEnvironment(authToken ?? null),
        timeout: CHECKOUT_TIMEOUT_MS,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
      }
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };

    const details =
      err.stderr?.trim() ||
      err.stdout?.trim() ||
      err.message ||
      "Git command failed";

    if (err.code === "ETIMEDOUT") {
      throw new SourceCheckoutError("GIT_TIMEOUT", "Git operation exceeded the configured timeout");
    }

    throw new SourceCheckoutError(
      "GIT_COMMAND_FAILED",
      details.slice(-4000)
    );
  }
}

export async function withCheckedOutRepository<T>(
  options: SourceCheckoutOptions,
  work: (
    checkout: SourceCheckoutResult
  ) => Promise<T>
): Promise<T> {
  const repositoryUrl = validateRepositoryUrl(
    options.repositoryUrl
  );

  const branch = validateBranch(options.branch);

  let targetSha: string | null = null;
  if (options.targetCommitSha !== undefined && options.targetCommitSha !== null) {
    const normalized = options.targetCommitSha.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(normalized)) {
      throw new SourceCheckoutError("INVALID_COMMIT_SHA", "Invalid target commit SHA");
    }
    targetSha = normalized;
  }

  await mkdir(CHECKOUT_ROOT, {
    recursive: true,
  });

  const workspace = path.join(
    CHECKOUT_ROOT,
    `deployment-${randomUUID()}`
  );

  await mkdir(workspace);

  const gitBase = baseGitConfig();
  const authToken = options.authToken ?? null;
  if (authToken !== null) validateAuthToken(authToken);

  try {
    await runGit([
      ...gitBase,
      "clone",
      "--depth",
      "1",
      "--no-tags",
      "--single-branch",
      "--no-recurse-submodules",
      "--branch",
      branch,
      repositoryUrl.toString(),
      workspace,
    ], undefined, authToken);

    if (targetSha) {
      await runGit([...gitBase, "fetch", "--depth", "1", "origin", targetSha], workspace, authToken);
      await runGit([...gitBase, "checkout", "--detach", targetSha], workspace, authToken);
    }

    const { stdout } = await runGit(
      [
        ...gitBase,
        "rev-parse",
        "HEAD",
      ],
      workspace,
      authToken
    );

    const commitSha = stdout.trim();

    if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
      throw new SourceCheckoutError("INVALID_COMMIT_SHA", "Git returned an invalid commit SHA");
    }

    if (targetSha && commitSha.toLowerCase() !== targetSha) {
      throw new SourceCheckoutError("COMMIT_MISMATCH", "Checked-out commit does not match the requested SHA");
    }

    return await work({
      workspace,
      commitSha,
    });
  } finally {
    await rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}
