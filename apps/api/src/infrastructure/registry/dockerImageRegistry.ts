import { spawn } from "node:child_process";

import {
  buildImageReference,
  digestReference,
  validateImageDigest,
  validateRegistryRepository,
  validateRegistryTag,
  getRegistryConfig,
  type RegistryConfig,
} from "./registryConfig.js";
import {
  RegistryError,
  type ImageDigest,
  type ImageRegistry,
  type PushedImage,
  type PushInput,
  type RegistryErrorCode,
} from "./imageRegistry.js";
import { RegistryConfigError } from "./registryConfig.js";

const DEFAULT_DOCKER_BINARY = "docker";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PUSH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;

export interface DockerImageRegistryOptions {
  config?: RegistryConfig;
  dockerBinary?: string;
  timeoutMs?: number;
  pushTimeoutMs?: number;
}

export function validateLocalReference(ref: string): string {
  const value = ref.trim();

  if (!value || value.length > 1024) {
    throw new RegistryError(
      "INVALID_REFERENCE",
      "Local image reference is invalid"
    );
  }

  if (value.startsWith("-")) {
    throw new RegistryError(
      "INVALID_REFERENCE",
      "Local image reference is invalid"
    );
  }

  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f'"`$\\;&|<>!()*?]/.test(value)) {
    throw new RegistryError(
      "INVALID_REFERENCE",
      "Local image reference contains invalid characters"
    );
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    throw new RegistryError(
      "INVALID_REFERENCE",
      "Local image reference must not include a URL scheme"
    );
  }

  return value;
}

export function validateDigestReference(ref: string): {
  repository: string;
  digest: string;
} {
  const value = ref.trim();

  if (!value || value.length > 1024) {
    throw new RegistryError(
      "INVALID_REFERENCE",
      "Image reference is invalid"
    );
  }

  const atIndex = value.lastIndexOf("@");

  if (atIndex <= 0) {
    throw new RegistryError(
      "INVALID_REFERENCE",
      "Image reference must be an immutable digest reference (repository@sha256:...)"
    );
  }

  const repository = validateRegistryRepository(
    value.slice(0, atIndex)
  );
  const digest = validateImageDigest(value.slice(atIndex + 1));

  return { repository, digest };
}

export function parseImagetoolsDigest(stdout: string): string | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("digest" in parsed) ||
    typeof (parsed as { digest: unknown }).digest !== "string"
  ) {
    return null;
  }

  const digest = (parsed as { digest: string }).digest.trim();

  if (!DIGEST_PATTERN.test(digest)) {
    return null;
  }

  return digest.toLowerCase();
}

export function isNotFoundMessage(stderr: string): boolean {
  return /manifest unknown|not found|no such manifest|no such image|unknown blob/i.test(
    stderr
  );
}

export function isAuthMessage(stderr: string): boolean {
  return /unauthorized|authentication required|denied|forbidden|invalid username|login required/i.test(
    stderr
  );
}

export function isNetworkMessage(stderr: string): boolean {
  return /connection refused|connection reset|no such host|name or service not known|network is unreachable|dial tcp|econnrefused|enotfound|etimedout|timeout/i.test(
    stderr
  );
}

export function classifyDockerFailure(
  stderr: string,
  timedOut: boolean
): { code: RegistryErrorCode; retryable: boolean } {
  if (timedOut) {
    return { code: "TIMEOUT", retryable: true };
  }

  if (isAuthMessage(stderr)) {
    return { code: "AUTH_FAILED", retryable: false };
  }

  if (isNetworkMessage(stderr)) {
    return { code: "REGISTRY_UNAVAILABLE", retryable: true };
  }

  return { code: "PUSH_FAILED", retryable: false };
}

interface CommandResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  code: number;
}

function appendTail(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();

  if (Buffer.byteLength(next, "utf8") <= MAX_OUTPUT_BYTES) {
    return next;
  }

  const buffer = Buffer.from(next, "utf8");

  return buffer
    .subarray(buffer.length - MAX_OUTPUT_BYTES)
    .toString("utf8");
}

function runDockerCommand(
  binary: string,
  args: string[],
  timeoutMs: number
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk);
    });

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

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        code: code ?? 1,
      });
    });
  });
}

export class DockerImageRegistry implements ImageRegistry {
  private readonly config: RegistryConfig;
  private readonly dockerBinary: string;
  private readonly timeoutMs: number;
  private readonly pushTimeoutMs: number;

  constructor(options: DockerImageRegistryOptions = {}) {
    this.config = options.config ?? getRegistryConfig();
    this.dockerBinary =
      options.dockerBinary ??
      process.env.DEPLOYKIT_DOCKER_BINARY ??
      DEFAULT_DOCKER_BINARY;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pushTimeoutMs =
      options.pushTimeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
  }

  get registryHost(): string {
    return this.config.registryHost;
  }

  private assertManagedRepository(repository: string): void {
    const prefix = `${this.config.registryHost}/`;

    if (!repository.startsWith(prefix)) {
      throw new RegistryError(
        "INVALID_REFERENCE",
        "Image repository is not under the configured registry"
      );
    }
  }

  private async run(
    args: string[],
    timeoutMs: number
  ): Promise<CommandResult> {
    try {
      return await runDockerCommand(
        this.dockerBinary,
        args,
        timeoutMs
      );
    } catch {
      throw new RegistryError(
        "REGISTRY_UNAVAILABLE",
        "Docker command could not be executed",
        true
      );
    }
  }

  async push(input: PushInput): Promise<PushedImage> {
    let localReference: string;
    let repository: string;
    let tag: string;

    try {
      localReference = validateLocalReference(input.localReference);
      repository = validateRegistryRepository(input.repository);
      tag = validateRegistryTag(input.tag);
    } catch (error) {
      if (error instanceof RegistryConfigError) {
        throw new RegistryError(
          "INVALID_REFERENCE",
          error.message
        );
      }
      throw error;
    }

    this.assertManagedRepository(repository);

    const target = buildImageReference(repository, tag);

    const tagResult = await this.run(
      ["image", "tag", localReference, target],
      this.timeoutMs
    );

    if (tagResult.timedOut || tagResult.code !== 0) {
      const classified = classifyDockerFailure(
        tagResult.stderr,
        tagResult.timedOut
      );
      throw new RegistryError(
        classified.code === "PUSH_FAILED"
          ? "PUSH_FAILED"
          : classified.code,
        "Image tag step failed",
        classified.retryable
      );
    }

    const pushResult = await this.run(
      ["image", "push", target],
      this.pushTimeoutMs
    );

    if (pushResult.timedOut || pushResult.code !== 0) {
      const classified = classifyDockerFailure(
        pushResult.stderr,
        pushResult.timedOut
      );
      throw new RegistryError(
        classified.code,
        "Registry push failed",
        classified.retryable
      );
    }

    // Resolve the digest from the registry itself (not the local
    // RepoDigests cache): after pushing multi-platform-capable
    // content, the stored manifest digest can differ from the local
    // image digest, and only the stored digest is pullable/runnable.
    const resolveResult = await this.run(
      [
        "buildx",
        "imagetools",
        "inspect",
        "--format",
        "{{json .Manifest}}",
        target,
      ],
      this.timeoutMs
    );

    if (resolveResult.timedOut || resolveResult.code !== 0) {
      const classified = classifyDockerFailure(
        resolveResult.stderr,
        resolveResult.timedOut
      );
      throw new RegistryError(
        classified.code,
        "Pushed image digest could not be determined",
        classified.retryable
      );
    }

    const digest = parseImagetoolsDigest(resolveResult.stdout);

    if (!digest || !DIGEST_PATTERN.test(digest)) {
      throw new RegistryError(
        "DIGEST_MISSING",
        "Pushed image digest could not be determined"
      );
    }

    return {
      repository,
      digest: digest as ImageDigest,
      reference: digestReference(repository, digest),
    };
  }

  async exists(reference: string): Promise<boolean> {
    let repository: string;
    let digest: string;

    try {
      ({ repository, digest } = validateDigestReference(reference));
    } catch (error) {
      if (error instanceof RegistryConfigError) {
        throw new RegistryError(
          "INVALID_REFERENCE",
          error.message
        );
      }
      throw error;
    }

    const digestRef = digestReference(repository, digest);

    // `manifest inspect` cannot speak plain HTTP to insecure local
    // registries; imagetools resolves digest references correctly.
    const result = await this.run(
      [
        "buildx",
        "imagetools",
        "inspect",
        "--format",
        "{{json .Manifest}}",
        digestRef,
      ],
      this.timeoutMs
    );

    if (result.timedOut) {
      throw new RegistryError(
        "TIMEOUT",
        "Registry lookup timed out",
        true
      );
    }

    if (result.code === 0) {
      return true;
    }

    if (isNotFoundMessage(result.stderr)) {
      return false;
    }

    if (isAuthMessage(result.stderr)) {
      throw new RegistryError(
        "AUTH_FAILED",
        "Registry authentication failed"
      );
    }

    if (isNetworkMessage(result.stderr)) {
      throw new RegistryError(
        "REGISTRY_UNAVAILABLE",
        "Registry is unavailable",
        true
      );
    }

    throw new RegistryError(
      "REGISTRY_UNAVAILABLE",
      "Registry lookup failed",
      true
    );
  }
}
