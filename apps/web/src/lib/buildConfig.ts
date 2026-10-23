export const BUILDERS = ["dockerfile", "node", "python", "rust", "static"] as const;
export type Builder = (typeof BUILDERS)[number];

export const BUILDER_LABELS: Record<Builder, string> = {
  dockerfile: "Dockerfile",
  node: "Node.js",
  python: "Python",
  rust: "Rust",
  static: "Static site",
};

export type BuildConfig = {
  applicationRoot: string;
  builder: Builder;
  dockerfilePath: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
};

export type ConfigSource = "explicit" | "detected" | "default";
export type EffectiveBuildConfig = BuildConfig & {
  sources: Record<keyof BuildConfig, ConfigSource>;
};

export type Confidence = "high" | "medium" | "low";
export type DetectionStatus = "detected" | "ambiguous" | "unsupported";

export type DetectionEvidence = {
  file: string;
  fact: string;
  type: string;
};

export type DetectionSuggestion = {
  field: string;
  value: string;
  basis: string;
  confidence: Confidence;
};

export type DetectionResponse = {
  status: DetectionStatus;
  commitSha: string;
  detected: {
    config: BuildConfig;
    language: string;
    framework: string;
    confidence: Confidence;
    needsReview: boolean;
    evidence: DetectionEvidence[];
    suggestions: DetectionSuggestion[];
  } | null;
  ambiguous: { code: string; message: string; candidates: string[] } | null;
  unsupported: { code: string; message: string } | null;
  explicit: BuildConfig | null;
  effective: EffectiveBuildConfig | null;
  explicitIssues: string[];
};

export type BuildConfigResponse = {
  config: BuildConfig | null;
  updatedAt: string | null;
};

export type SavedBuildConfigResponse = {
  config: BuildConfig;
  updatedAt: string;
};

export type DraftBuildConfig = Record<keyof BuildConfig, string>;
export type FieldErrors = Partial<Record<keyof BuildConfig, string>>;

export const FIELD_LABELS: Record<keyof BuildConfig, string> = {
  applicationRoot: "Application root",
  builder: "Builder",
  dockerfilePath: "Dockerfile path",
  buildCommand: "Build command",
  startCommand: "Start command",
  outputDirectory: "Output directory",
};

export const EFFECTIVE_FIELDS: (keyof BuildConfig)[] = [
  "applicationRoot",
  "builder",
  "dockerfilePath",
  "buildCommand",
  "startCommand",
  "outputDirectory",
];

const DRAFT_FIELDS = EFFECTIVE_FIELDS;

const DRIVE_PREFIX = /^[A-Za-z]:/;

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isBuilder(value: string): value is Builder {
  return (BUILDERS as readonly string[]).includes(value);
}

export function isDraftField(value: string): value is keyof DraftBuildConfig {
  return (DRAFT_FIELDS as readonly string[]).includes(value);
}

export function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !hasControlChars(value) &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !DRIVE_PREFIX.test(value) &&
    !value.startsWith("~") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

export function isSafeApplicationRoot(value: string): boolean {
  return value === "." || isSafeRelativePath(value);
}

export function emptyDraft(): DraftBuildConfig {
  return {
    applicationRoot: ".",
    builder: "",
    dockerfilePath: "",
    buildCommand: "",
    startCommand: "",
    outputDirectory: "",
  };
}

export function draftFromConfig(config: BuildConfig): DraftBuildConfig {
  return {
    applicationRoot: config.applicationRoot,
    builder: config.builder,
    dockerfilePath: config.dockerfilePath ?? "",
    buildCommand: config.buildCommand ?? "",
    startCommand: config.startCommand ?? "",
    outputDirectory: config.outputDirectory ?? "",
  };
}

function commandError(value: string): string | undefined {
  if (value.length === 0) return undefined;
  if (value.length > 2000) return "Use 2000 characters or fewer.";
  if (hasControlChars(value)) return "Control characters are not allowed.";
  return undefined;
}

export function validateDraft(draft: DraftBuildConfig): FieldErrors {
  const errors: FieldErrors = {};

  if (draft.applicationRoot !== "" && !isSafeApplicationRoot(draft.applicationRoot)) {
    errors.applicationRoot = 'Use a safe relative path, or "." for the repository root.';
  }
  if (!isBuilder(draft.builder)) {
    errors.builder = "Select a builder.";
  }
  if (draft.builder === "dockerfile") {
    if (!draft.dockerfilePath) {
      errors.dockerfilePath = "Dockerfile path is required for the Dockerfile builder.";
    } else if (!isSafeRelativePath(draft.dockerfilePath)) {
      errors.dockerfilePath = "Use a safe relative path.";
    }
  }
  if (draft.outputDirectory && !isSafeRelativePath(draft.outputDirectory)) {
    errors.outputDirectory = "Use a safe relative path.";
  }
  const buildCommandError = commandError(draft.buildCommand);
  if (buildCommandError) errors.buildCommand = buildCommandError;
  const startCommandError = commandError(draft.startCommand);
  if (startCommandError) errors.startCommand = startCommandError;

  return errors;
}

function orNull(value: string): string | null {
  return value.length > 0 ? value : null;
}

export function draftToBuildConfig(draft: DraftBuildConfig): BuildConfig {
  if (!isBuilder(draft.builder)) {
    throw new Error("Builder is required");
  }
  return {
    applicationRoot: draft.applicationRoot === "" ? "." : draft.applicationRoot,
    builder: draft.builder,
    dockerfilePath: draft.builder === "dockerfile" ? orNull(draft.dockerfilePath) : null,
    buildCommand: orNull(draft.buildCommand),
    startCommand: orNull(draft.startCommand),
    outputDirectory: orNull(draft.outputDirectory),
  };
}

export function fieldErrorFromMessage(message: string): {
  field?: keyof BuildConfig;
  message: string;
} {
  const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/.exec(message);
  if (match && isDraftField(match[1])) {
    return { field: match[1], message: match[2] };
  }
  return { message };
}

export function configValue(value: string | null): string {
  return value && value.length > 0 ? value : "not set";
}

export function sourceLabel(source: ConfigSource): string {
  if (source === "explicit") return "saved";
  if (source === "detected") return "detected";
  return "default";
}
