import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../process/dockerExec.js";

import type {
  BuildExecutor,
  BuildPolicy,
  BuildRequest,
  BuildResult,
} from "./buildExecutor.js";

const DEFAULT_BUILDER = "deploykit-builder";
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;

export class BuildExecutorError extends Error {
  readonly code: string;
  readonly details?: string;

  constructor(
    code: string,
    message: string,
    details?: string
  ) {
    super(message);
    this.name = "BuildExecutorError";
    this.code = code;
    this.details = details;
  }
}

export interface BuildxBuildExecutorOptions {
  builder?: string;
  dockerBinary?: string;
}

export function validateImageRepository(repository: string): string {
  const v = repository.trim();
  const err = (m: string): never => {
    throw new BuildExecutorError("INVALID_IMAGE_REPOSITORY", m);
  };
  if (!v) err("Image repository must not be empty");
  if (v.length > 255) err("Image repository is too long");
  if (v !== v.toLowerCase()) err("Image repository must use lowercase characters");
  if (v.includes("@")) err("Image repository must not contain a digest");
  const parts = v.split("/").filter(Boolean);
  if (!parts.length) err("Invalid image repository");
  let start = 0;
  const first = parts[0];
  if (first === "localhost" || first.includes(".") || first.includes(":")) {
    if (!/^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?$/.test(first)) err("Invalid image registry");
    start = 1;
  }
  if (start >= parts.length) err("Image repository must contain a repository path");
  for (const p of parts.slice(start)) {
    if (!p.length || p.length > 255 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(p)) err(`Invalid image repository component: ${p}`);
  }
  return v;
}

export function validateImageTag(tag: string): string {
  const v = tag.trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(v)) throw new BuildExecutorError("INVALID_IMAGE_TAG", "Invalid Docker image tag");
  return v;
}

export interface BuildxBuildArgsInput {
  builder: string;
  imageReference: string;
  commitSha: string;
  policy: BuildPolicy;
  push?: boolean;
  cacheRef?: string | null;
}

export const BUILD_CACHE_TAG = "buildcache";

export function selectCacheRef(input: {
  push: boolean;
  cacheEnabled?: boolean;
  imageRepository: string;
  cacheTag?: string | null;
}): string | null {
  if (!input.push || input.cacheEnabled === false || !input.cacheTag) {
    return null;
  }
  const repository = validateImageRepository(input.imageRepository);
  const tag = validateImageTag(input.cacheTag);
  return `${repository}:${tag}`;
}

function appendCacheArgs(args: string[], cacheRef: string | null): void {
  if (!cacheRef) {
    return;
  }
  const separator = cacheRef.lastIndexOf(":");
  if (separator <= 0) {
    throw new BuildExecutorError("INVALID_IMAGE_REPOSITORY", "Build cache reference must be repository:tag");
  }
  validateImageRepository(cacheRef.slice(0, separator));
  validateImageTag(cacheRef.slice(separator + 1));
  args.push(
    "--cache-from",
    `type=registry,ref=${cacheRef}`,
    "--cache-to",
    `type=registry,ref=${cacheRef},mode=max`
  );
}

export function shouldRetryWithoutCache(
  error: unknown,
  cacheUsed: boolean,
  signalAborted: boolean
): boolean {
  if (!cacheUsed || signalAborted) {
    return false;
  }
  return (
    error instanceof BuildExecutorError &&
    (error.code === "BUILD_FAILED" ||
      error.code === "BUILD_EXECUTION_FAILED")
  );
}

export function buildBuildxArgs(input: BuildxBuildArgsInput): string[] {
  const push = input.push ?? false;

  const memoryBytes = input.policy.memoryBytes;
  const cpuLimit = input.policy.cpuLimit;
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) {
    throw new BuildExecutorError("INVALID_BUILD_POLICY", "Build memory limit must be positive");
  }
  if (!Number.isSafeInteger(cpuLimit) || cpuLimit <= 0) {
    throw new BuildExecutorError("INVALID_BUILD_POLICY", "Build CPU limit must be positive");
  }
  const cpuQuota = cpuLimit * 100_000;

  const args = [
    "buildx",
    "build",

    "--builder",
    input.builder,

    "--progress",
    "plain",

    "--metadata-file",
    "<metadata-file>",

    "--tag",
    input.imageReference,

    push ? "--push" : "--load",

    "--resource",
    `memory=${memoryBytes}`,

    "--resource",
    `cpu-quota=${cpuQuota}`,

    "--label",
    `org.opencontainers.image.revision=${input.commitSha}`,

    "--label",
    "io.deploykit.managed=true",
  ];

  args.push(
    "--network",
    input.policy.networkEnabled ? "default" : "none"
  );

  if (input.push ?? false) {
    appendCacheArgs(args, input.cacheRef ?? null);
  }

  return args;
}

async function getDirectorySize(
  root: string,
  limitBytes: number
): Promise<number> {
  const pending = [root];
  let total = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;

    const stat = await lstat(current);

    if (stat.isSymbolicLink()) {
      total += stat.size;
    } else if (stat.isFile()) {
      total += stat.size;
    } else if (stat.isDirectory()) {
      const entries = await readdir(current);

      for (const entry of entries) {
        pending.push(path.join(current, entry));
      }
    }

    if (total > limitBytes) {
      throw new BuildExecutorError("BUILD_CONTEXT_TOO_LARGE", `Build context exceeds the configured limit of ${limitBytes} bytes`);
    }
  }

  return total;
}

async function assertBuildContext(
  workspace: string,
  maxBytes: number
): Promise<void> {
  const resolvedWorkspace = path.resolve(workspace);
  const stat = await lstat(resolvedWorkspace);

  if (!stat.isDirectory()) {
    throw new BuildExecutorError("INVALID_BUILD_CONTEXT", "Build context must be a directory");
  }

  const dockerfile = path.join(
    resolvedWorkspace,
    "Dockerfile"
  );

  let dockerfileStat;

  try {
    dockerfileStat = await lstat(dockerfile);
  } catch {
    throw new BuildExecutorError("DOCKERFILE_NOT_FOUND", "Repository does not contain a Dockerfile");
  }

  if (
    !dockerfileStat.isFile() ||
    dockerfileStat.isSymbolicLink()
  ) {
    throw new BuildExecutorError("INVALID_DOCKERFILE", "Dockerfile must be a regular file");
  }

  await getDirectorySize(
    resolvedWorkspace,
    maxBytes
  );
}

async function runBuild(
  binary: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  onLog?: (line: string) => void
) {

  let buffer = "";
  const flush = (final = false) => {
    const parts = buffer.split("\n");
    buffer = final ? "" : (parts.pop() ?? "");
    for (const part of parts) {
      const line = part.trimEnd();
      if (!line.trim()) continue;
      try {
        onLog?.(line.slice(0, 4000));
      } catch {
      }
    }

    if (buffer.length > 16384) buffer = buffer.slice(-16384);
  };
  try {
    return await runCommand(binary, args, timeoutMs, {
      ...process.env,
      DOCKER_BUILDKIT: "1",
      BUILDKIT_PROGRESS: "plain",
      BUILDX_METADATA_WARNINGS: "1",
    }, signal, onLog ? ({ chunk }) => {
      buffer += chunk;
      if (buffer.length > 8192 || buffer.includes("\n")) flush();
    } : undefined).finally(() => {
      if (onLog && buffer.trim()) {
        try {
          onLog(buffer.trim().slice(0, 4000));
        } catch { /* ignore */ }
      }
    });
  } catch (e) {
    if (signal?.aborted) {
      throw new BuildExecutorError("BUILD_CANCELLED", "Docker build was cancelled");
    }
    throw new BuildExecutorError("BUILD_EXECUTION_FAILED", "Failed to execute Docker Buildx", e instanceof Error ? e.message : String(e));
  }
}

async function readDigest(metadataFile: string): Promise<string> {
  let raw: string;

  try {
    raw = await readFile(metadataFile, "utf8");
  } catch (error) {
    throw new BuildExecutorError(
      "BUILD_METADATA_UNAVAILABLE",
      "Build metadata file could not be read",
      error instanceof Error
        ? error.message
        : String(error)
    );
  }

  let metadata: Record<string, unknown>;

  try {
    metadata = JSON.parse(raw) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new BuildExecutorError(
      "BUILD_METADATA_INVALID",
      "Build metadata is not valid JSON",
      error instanceof Error
        ? error.message
        : String(error)
    );
  }

  const digest = metadata["containerimage.digest"];

  if (
    typeof digest !== "string" ||
    !SHA256_DIGEST_PATTERN.test(digest)
  ) {
    throw new BuildExecutorError("BUILD_DIGEST_MISSING", "Build metadata did not contain a valid image digest");
  }

  return digest;
}

export class BuildxBuildExecutor
  implements BuildExecutor
{
  private readonly builder: string;
  private readonly dockerBinary: string;

  constructor(
    options: BuildxBuildExecutorOptions = {}
  ) {
    this.builder =
      options.builder ??
      process.env.DEPLOYKIT_BUILDER_NAME ??
      DEFAULT_BUILDER;

    this.dockerBinary =
      options.dockerBinary ??
      process.env.DEPLOYKIT_DOCKER_BINARY ??
      "docker";
  }

  async build(
    request: BuildRequest
  ): Promise<BuildResult> {
    const repository = validateImageRepository(
      request.imageRepository
    );

    const tag = validateImageTag(
      request.imageTag
    );

    if (!/^[0-9a-f]{40}$/i.test(request.commitSha)) {
      throw new BuildExecutorError("INVALID_COMMIT_SHA", "Build requires a valid 40-char commit SHA");
    }

    if (
      !Number.isSafeInteger(request.policy.timeoutMs) ||
      request.policy.timeoutMs <= 0
    ) {
      throw new BuildExecutorError("INVALID_BUILD_POLICY", "Build timeout must be positive");
    }

    if (
      !Number.isSafeInteger(request.policy.memoryBytes) ||
      request.policy.memoryBytes <= 0
    ) {
      throw new BuildExecutorError("INVALID_BUILD_POLICY", "Build memory limit must be positive");
    }

    if (
      !Number.isSafeInteger(request.policy.cpuLimit) ||
      request.policy.cpuLimit <= 0
    ) {
      throw new BuildExecutorError("INVALID_BUILD_POLICY", "Build CPU limit must be positive");
    }

    await assertBuildContext(
      request.workspace,
      request.policy.maxBuildContextBytes
    );

    const metadataDirectory = await mkdtemp(
      path.join(
        os.tmpdir(),
        "deploykit-build-metadata-"
      )
    );

    const metadataFile = path.join(
      metadataDirectory,
      "metadata.json"
    );

    try {
      const push = request.push ?? false;
      const cacheRef = selectCacheRef({
        push,
        cacheEnabled: request.policy.cacheEnabled,
        imageRepository: repository,
        cacheTag: request.cacheTag ?? null,
      });

      try {
        return await this.runBuildOnce(
          repository,
          tag,
          request,
          metadataFile,
          push,
          cacheRef
        );
      } catch (error) {
        if (
          shouldRetryWithoutCache(error, cacheRef !== null, request.signal?.aborted ?? false)
        ) {
          try {
            request.onLog?.("build cache unavailable; retrying without cache");
          } catch {
          }
          return await this.runBuildOnce(
            repository,
            tag,
            request,
            metadataFile,
            push,
            null
          );
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof BuildExecutorError) {
        throw error;
      }

      throw new BuildExecutorError(
        "BUILD_EXECUTION_FAILED",
        "Failed to execute Docker Buildx",
        error instanceof Error
          ? error.message
          : String(error)
      );
    } finally {
      await rm(metadataDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  }

  private async runBuildOnce(
    repository: string,
    tag: string,
    request: BuildRequest,
    metadataFile: string,
    push: boolean,
    cacheRef: string | null
  ): Promise<BuildResult> {
    const imageReference = `${repository}:${tag}`;

    const args = buildBuildxArgs({
      builder: this.builder,
      imageReference,
      commitSha: request.commitSha,
      policy: request.policy,
      push,
      cacheRef,
    }).map((arg) =>
      arg === "<metadata-file>" ? metadataFile : arg
    );

    args.push(request.workspace);

    const result = await runBuild(this.dockerBinary, args, request.policy.timeoutMs, request.signal, request.onLog);

    if (result.aborted || request.signal?.aborted) {
      throw new BuildExecutorError("BUILD_CANCELLED", "Docker build was cancelled", result.stderr);
    }

    if (result.timedOut) {
      throw new BuildExecutorError("BUILD_TIMEOUT", `Docker build exceeded timeout of ${request.policy.timeoutMs}ms`, result.stderr);
    }

    if (result.code !== 0) {
      throw new BuildExecutorError("BUILD_FAILED", "Docker Buildx build failed", result.stderr);
    }

    const imageDigest = await readDigest(
      metadataFile
    );

    return {
      imageReference,
      imageDigest,
    };
  }
}
