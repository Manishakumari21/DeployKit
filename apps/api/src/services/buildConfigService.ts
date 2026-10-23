import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import pool from "../db/database.js";

export const BUILDERS = ["dockerfile", "node", "python", "rust", "static"] as const;
export type Builder = (typeof BUILDERS)[number];

export class BuildConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "BuildConfigError";
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const isUnsafePath = (value: string): boolean =>
  CONTROL_CHARS.test(value) ||
  value.includes("\\") ||
  value.startsWith("/") ||
  /^[A-Za-z]:/.test(value) ||
  value.startsWith("~") ||
  value.split("/").some((segment) => !segment || segment === "." || segment === "..");

const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !isUnsafePath(value), "must be a safe relative path");

const command = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => !CONTROL_CHARS.test(value), "must not contain control characters");

export const buildConfigSchema = z
  .object({
    applicationRoot: z.union([z.literal("."), relativePath]).default("."),
    builder: z.enum(BUILDERS),
    dockerfilePath: relativePath.nullable().default(null),
    buildCommand: command.nullable().default(null),
    startCommand: command.nullable().default(null),
    outputDirectory: relativePath.nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.builder === "dockerfile" && !value.dockerfilePath) {
      ctx.addIssue({
        code: "custom",
        path: ["dockerfilePath"],
        message: "required for the dockerfile builder",
      });
    }
    if (value.builder !== "dockerfile" && value.dockerfilePath) {
      ctx.addIssue({
        code: "custom",
        path: ["dockerfilePath"],
        message: "only allowed for the dockerfile builder",
      });
    }
  });

export type BuildConfig = z.infer<typeof buildConfigSchema>;

export function parseBuildConfig(input: unknown): BuildConfig {
  const result = buildConfigSchema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  throw new BuildConfigError(
    "INVALID_CONFIG",
    `${where}${issue?.message ?? "Invalid build configuration"}`.slice(0, 300)
  );
}

export interface ValidatedBuildConfig {
  config: BuildConfig;
  applicationRootAbsolute: string;
  dockerfileAbsolute: string | null;
  outputDirectoryAbsolute: string | null;
}

type TargetKind = "dir" | "file";

function realpathOrThrow(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    throw new BuildConfigError("PATH_NOT_FOUND", "Path does not exist in the repository");
  }
}

function resolveInside(
  workspace: string,
  relative: string,
  kind: TargetKind,
  allowMissing = false
): string {
  const segments = relative === "." ? [] : relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new BuildConfigError("PATH_ESCAPE", "Path escapes the repository root");
  }

  if (segments.length === 0) {
    if (kind === "file") {
      throw new BuildConfigError("INVALID_PATH", "Path must be a regular file");
    }
    return workspace;
  }

  const target = path.resolve(workspace, ...segments);
  const relativeTarget = path.relative(workspace, target);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new BuildConfigError("PATH_ESCAPE", "Path escapes the repository root");
  }

  let current = workspace;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const isFinal = index === segments.length - 1;

    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!allowMissing || !missing) {
        throw new BuildConfigError("PATH_NOT_FOUND", "Path does not exist in the repository");
      }
      return target;
    }

    if (stat.isSymbolicLink()) {
      throw new BuildConfigError("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
    }

    const canonical = realpathOrThrow(current);
    if (canonical !== current) {
      throw new BuildConfigError(
        "SYMLINK_NOT_ALLOWED",
        "Path must not traverse symbolic links"
      );
    }
    const relativeCanonical = path.relative(workspace, canonical);
    if (relativeCanonical.startsWith("..") || path.isAbsolute(relativeCanonical)) {
      throw new BuildConfigError("PATH_ESCAPE", "Path escapes the repository root");
    }

    if (!isFinal) {
      if (!stat.isDirectory()) {
        throw new BuildConfigError("INVALID_PATH", "Path must be a directory");
      }
    } else if (kind === "dir" ? !stat.isDirectory() : !stat.isFile()) {
      throw new BuildConfigError(
        "INVALID_PATH",
        kind === "dir" ? "Path must be a directory" : "Path must be a regular file"
      );
    }
  }

  return target;
}

export function validateBuildConfigAgainstWorkspace(
  workspace: string,
  input: unknown
): ValidatedBuildConfig {
  const config = parseBuildConfig(input);

  let root: string;
  try {
    root = realpathSync(workspace);
    if (!statSync(root).isDirectory()) {
      throw new Error("workspace is not a directory");
    }
  } catch {
    throw new BuildConfigError(
      "WORKSPACE_UNAVAILABLE",
      "Repository workspace is unavailable",
      500
    );
  }

  const applicationRootAbsolute = resolveInside(root, config.applicationRoot, "dir");
  const dockerfileAbsolute =
    config.builder === "dockerfile"
      ? resolveInside(
          root,
          config.applicationRoot === "."
            ? (config.dockerfilePath as string)
            : `${config.applicationRoot}/${config.dockerfilePath as string}`,
          "file"
        )
      : null;

  const outputDirectoryAbsolute = config.outputDirectory
    ? resolveInside(applicationRootAbsolute, config.outputDirectory, "dir", true)
    : null;

  return { config, applicationRootAbsolute, dockerfileAbsolute, outputDirectoryAbsolute };
}

export interface StoredBuildConfig {
  config: BuildConfig;
  updatedAt: string;
}

function toStored(row: { build_config: unknown; updated_at: string }): StoredBuildConfig {
  return { config: parseBuildConfig(row.build_config), updatedAt: row.updated_at };
}

export async function getProjectBuildConfig(
  projectId: string
): Promise<StoredBuildConfig | null> {
  const result = await pool.query(
    `SELECT build_config, updated_at FROM projects WHERE id = $1`,
    [projectId]
  );
  if (!result.rowCount) {
    throw new BuildConfigError("PROJECT_NOT_FOUND", "Project not found", 404);
  }
  const row = result.rows[0];
  return row.build_config == null ? null : toStored(row);
}

export async function saveProjectBuildConfig(
  projectId: string,
  input: unknown
): Promise<StoredBuildConfig> {
  const config = parseBuildConfig(input);
  const result = await pool.query(
    `UPDATE projects
        SET build_config = $2::jsonb, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING build_config, updated_at`,
    [projectId, JSON.stringify(config)]
  );
  if (!result.rowCount) {
    throw new BuildConfigError("PROJECT_NOT_FOUND", "Project not found", 404);
  }
  return toStored(result.rows[0]);
}

export async function clearProjectBuildConfig(projectId: string): Promise<void> {
  const result = await pool.query(
    `UPDATE projects
        SET build_config = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [projectId]
  );
  if (!result.rowCount) {
    throw new BuildConfigError("PROJECT_NOT_FOUND", "Project not found", 404);
  }
}

export type ConfigSource = "explicit" | "detected" | "default";
export type ConfigField = keyof BuildConfig;

export interface EffectiveBuildConfig extends BuildConfig {
  sources: Record<ConfigField, ConfigSource>;
}

const sourcesFor = (source: ConfigSource): Record<ConfigField, ConfigSource> => ({
  applicationRoot: source,
  builder: source,
  dockerfilePath: source,
  buildCommand: source,
  startCommand: source,
  outputDirectory: source,
});

export function resolveEffectiveConfig(
  explicit: BuildConfig | null,
  detected: BuildConfig | null
): EffectiveBuildConfig | null {
  if (!explicit && !detected) return null;

  if (!explicit || !detected || explicit.builder !== detected.builder) {
    const config = (explicit ?? detected) as BuildConfig;
    return { ...config, sources: sourcesFor(explicit ? "explicit" : "detected") };
  }

  const pick = <
    K extends "dockerfilePath" | "buildCommand" | "startCommand" | "outputDirectory",
  >(
    field: K
  ) => {
    const value = explicit[field] ?? detected[field];
    const source: ConfigSource =
      explicit[field] != null
        ? "explicit"
        : detected[field] != null
          ? "detected"
          : "explicit";
    return { value, source };
  };

  const dockerfile = pick("dockerfilePath");
  const build = pick("buildCommand");
  const start = pick("startCommand");
  const output = pick("outputDirectory");

  return {
    ...explicit,
    dockerfilePath: dockerfile.value,
    buildCommand: build.value,
    startCommand: start.value,
    outputDirectory: output.value,
    sources: {
      applicationRoot: "explicit",
      builder: "explicit",
      dockerfilePath: dockerfile.source,
      buildCommand: build.source,
      startCommand: start.source,
      outputDirectory: output.source,
    },
  };
}
