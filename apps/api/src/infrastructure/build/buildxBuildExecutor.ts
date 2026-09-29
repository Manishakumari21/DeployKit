import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  BuildExecutor,
  BuildRequest,
  BuildResult,
} from "./buildExecutor.js";

const DEFAULT_BUILDER = "deploykit-builder";
const MAX_ERROR_OUTPUT_BYTES = 64 * 1024;
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

export function validateImageRepository(
  repository: string
): string {
  const value = repository.trim();

  if (!value) {
    throw new BuildExecutorError(
      "INVALID_IMAGE_REPOSITORY",
      "Image repository must not be empty"
    );
  }

  if (value.length > 255) {
    throw new BuildExecutorError(
      "INVALID_IMAGE_REPOSITORY",
      "Image repository is too long"
    );
  }

  if (value !== value.toLowerCase()) {
    throw new BuildExecutorError(
      "INVALID_IMAGE_REPOSITORY",
      "Image repository must use lowercase characters"
    );
  }

  if (value.includes("@")) {
    throw new BuildExecutorError(
      "INVALID_IMAGE_REPOSITORY",
      "Image repository must not contain a digest"
    );
  }

  const parts = value.split("/").filter(Boolean);

  if (parts.length === 0) {
    throw new BuildExecutorError(
      "INVALID_IMAGE_REPOSITORY",
      "Invalid image repository"
    );
  }

  let start = 0;

  const first = parts[0];

  const looksLikeRegistry =
    first === "localhost" ||
    first.includes(".") ||
    first.includes(":");

  if (looksLikeRegistry) {
    if (
      !/^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?$/.test(
        first
      )
    ) {
      throw new BuildExecutorError(
        "INVALID_IMAGE_REPOSITORY",
        "Invalid image registry"
      );
    }

    start = 1;
  }

  if (start >= parts.length) {
    throw new BuildExecutorError(
      "INVALID_IMAGE_REPOSITORY",
      "Image repository must contain a repository path"
    );
  }

  for (const part of parts.slice(start)) {
    if (
      part.length === 0 ||
      part.length > 255 ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part)
    ) {
      throw new BuildExecutorError(
        "INVALID_IMAGE_REPOSITORY",
        `Invalid image repository component: ${part}`
      );
    }
  }

  return value;
}

export function validateImageTag(
  tag: string
): string {
  const value = tag.trim();

  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new BuildExecutorError(
      "INVALID_IMAGE_TAG",
      "Invalid Docker image tag"
    );
  }

  return value;
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
      throw new BuildExecutorError(
        "BUILD_CONTEXT_TOO_LARGE",
        `Build context exceeds the configured limit of ${limitBytes} bytes`
      );
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
    throw new BuildExecutorError(
      "INVALID_BUILD_CONTEXT",
      "Build context must be a directory"
    );
  }

  const dockerfile = path.join(
    resolvedWorkspace,
    "Dockerfile"
  );

  let dockerfileStat;

  try {
    dockerfileStat = await lstat(dockerfile);
  } catch {
    throw new BuildExecutorError(
      "DOCKERFILE_NOT_FOUND",
      "Repository does not contain a Dockerfile"
    );
  }

  if (
    !dockerfileStat.isFile() ||
    dockerfileStat.isSymbolicLink()
  ) {
    throw new BuildExecutorError(
      "INVALID_DOCKERFILE",
      "Dockerfile must be a regular file"
    );
  }

  await getDirectorySize(
    resolvedWorkspace,
    maxBytes
  );
}

function appendTail(
  current: string,
  chunk: Buffer | string
): string {
  const next = current + chunk.toString();

  if (Buffer.byteLength(next, "utf8") <= MAX_ERROR_OUTPUT_BYTES) {
    return next;
  }

  const buffer = Buffer.from(next, "utf8");

  return buffer
    .subarray(
      buffer.length - MAX_ERROR_OUTPUT_BYTES
    )
    .toString("utf8");
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
}

function runProcess(
  binary: string,
  args: string[],
  timeoutMs: number
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DOCKER_BUILDKIT: "1",
        BUILDKIT_PROGRESS: "plain",
        BUILDX_METADATA_WARNINGS: "1",
      },
      shell: false,
    });

    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on(
      "close",
      (code, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);

        resolve({
          code,
          signal,
          timedOut,
          stderr,
        });
      }
    );
  });
}

async function readDigest(
  metadataFile: string
): Promise<string> {
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
    throw new BuildExecutorError(
      "BUILD_DIGEST_MISSING",
      "Build metadata did not contain a valid image digest"
    );
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

    await assertBuildContext(
      request.workspace,
      request.policy.maxBuildContextBytes
    );

    const imageReference = `${repository}:${tag}`;

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
      const args = [
        "buildx",
        "build",

        "--builder",
        this.builder,

        "--progress",
        "plain",

        "--metadata-file",
        metadataFile,

        "--tag",
        imageReference,

        "--load",

        "--label",
        `org.opencontainers.image.revision=${request.commitSha}`,

        "--label",
        "io.deploykit.managed=true",
      ];

      args.push(
        "--network",
        request.policy.networkEnabled
          ? "default"
          : "none"
      );

      args.push(request.workspace);

      const result = await runProcess(
        this.dockerBinary,
        args,
        request.policy.timeoutMs
      );

      if (result.timedOut) {
        throw new BuildExecutorError(
          "BUILD_TIMEOUT",
          `Docker build exceeded timeout of ${request.policy.timeoutMs}ms`,
          result.stderr
        );
      }

      if (
        result.code !== 0 ||
        result.signal !== null
      ) {
        throw new BuildExecutorError(
          "BUILD_FAILED",
          "Docker Buildx build failed",
          result.stderr
        );
      }

      const imageDigest = await readDigest(
        metadataFile
      );

      return {
        imageReference,
        imageDigest,
      };
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
}
