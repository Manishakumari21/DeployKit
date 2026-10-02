export type ImageDigest = `sha256:${string}`;

export interface PushedImage {
  repository: string;
  digest: ImageDigest;
  reference: string;
}

export interface PushInput {
  localReference: string;
  repository: string;
  tag: string;
}

export interface ImageRegistry {
  push(input: PushInput): Promise<PushedImage>;
  exists(reference: string): Promise<boolean>;
}

export type RegistryErrorCode =
  | "REGISTRY_UNAVAILABLE"
  | "PUSH_FAILED"
  | "DIGEST_MISSING"
  | "AUTH_FAILED"
  | "INVALID_REFERENCE"
  | "TIMEOUT";

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  readonly retryable: boolean;

  constructor(
    code: RegistryErrorCode,
    message: string,
    retryable = false
  ) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class UnconfiguredImageRegistry implements ImageRegistry {
  async push(_input: PushInput): Promise<PushedImage> {
    throw new RegistryError("INVALID_REFERENCE", "Image registry is not configured");
  }

  async exists(_reference: string): Promise<boolean> {
    throw new RegistryError("INVALID_REFERENCE", "Image registry is not configured");
  }
}
