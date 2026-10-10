export class PipelineError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: string;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: string } = {}
  ) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export const PIPELINE_ERROR_CODES = {
  CLONE_FAILED: "CLONE_FAILED",
  BUILD_FAILED: "BUILD_FAILED",
  BUILD_TIMEOUT: "BUILD_TIMEOUT",
  BUILD_CANCELLED: "BUILD_CANCELLED",
  DEPLOYMENT_CANCELLED: "DEPLOYMENT_CANCELLED",
  INVALID_BUILD_CONTEXT: "INVALID_BUILD_CONTEXT",
  RELEASE_FAILED: "RELEASE_FAILED",
  RUNTIME_FAILED: "RUNTIME_FAILED",
  HEALTH_CHECK_FAILED: "HEALTH_CHECK_FAILED",
  ACTIVATION_FAILED: "ACTIVATION_FAILED",
  ROLLBACK_INVALID: "ROLLBACK_INVALID",
  PREFLIGHT_MISSING_INPUTS: "PREFLIGHT_MISSING_INPUTS",
  PREFLIGHT_NEEDS_CONFIG: "PREFLIGHT_NEEDS_CONFIG",
  PREFLIGHT_CONFLICTING_LOCKFILES: "PREFLIGHT_CONFLICTING_LOCKFILES",
  PREFLIGHT_UNSAFE_PATH: "PREFLIGHT_UNSAFE_PATH",
  PREFLIGHT_CHECK_FAILED: "PREFLIGHT_CHECK_FAILED",
} as const;
