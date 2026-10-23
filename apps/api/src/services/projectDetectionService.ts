import pool from "../db/database.js";
import {
  StackDetectorError,
  detectStack,
  type Confidence,
  type DetectionEvidence,
  type DetectionSuggestion,
  type Framework,
  type Language,
  type StackDetection,
} from "../infrastructure/build/stackDetector.js";
import { withCheckedOutRepository } from "../infrastructure/git/sourceCheckout.js";
import {
  BuildConfigError,
  getProjectBuildConfig,
  parseBuildConfig,
  resolveEffectiveConfig,
  validateBuildConfigAgainstWorkspace,
  type BuildConfig,
  type Builder,
  type EffectiveBuildConfig,
} from "./buildConfigService.js";

const MAX_EVIDENCE = 50;
const MAX_CANDIDATES = 50;
const MAX_TEXT = 300;

export const boundText = (value: string, max = MAX_TEXT): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

export type DetectionStatus = "detected" | "ambiguous" | "unsupported";

export interface DetectionResponse {
  status: DetectionStatus;
  commitSha: string;
  detected: {
    config: BuildConfig;
    language: Language;
    framework: Framework;
    confidence: Confidence;
    needsReview: boolean;
    evidence: { file: string; fact: string; type: string }[];
    suggestions: {
      field: string;
      value: string;
      basis: string;
      confidence: Confidence;
    }[];
  } | null;
  ambiguous: { code: string; message: string; candidates: string[] } | null;
  unsupported: { code: string; message: string } | null;
  explicit: BuildConfig | null;
  effective: EffectiveBuildConfig | null;
  explicitIssues: string[];
}

const evidence = (entries: DetectionEvidence[], pathPrefix = "") =>
  entries.slice(0, MAX_EVIDENCE).map(({ file, fact, type }) => ({
    file: boundText(pathPrefix ? `${pathPrefix}/${file}` : file),
    fact: boundText(fact),
    type,
  }));

const suggestions = (entries: DetectionSuggestion[]) =>
  entries.slice(0, MAX_EVIDENCE).map(({ field, value, basis, confidence }) => ({
    field,
    value: boundText(value),
    basis: boundText(basis),
    confidence,
  }));

const builderOf = (kind: StackDetection["kind"]): Builder => {
  if (kind === "needs-config") {
    throw new BuildConfigError(
      "UNSUPPORTED_DETECTION",
      "Detection did not produce a usable builder",
      500
    );
  }
  return kind;
};

export function detectionToConfig(
  detection: StackDetection,
  applicationRoot = "."
): BuildConfig {
  const builder = builderOf(detection.kind);
  return {
    applicationRoot,
    builder,
    dockerfilePath: builder === "dockerfile" ? "Dockerfile" : null,
    buildCommand: detection.buildCommand,
    startCommand: detection.startCommand,
    outputDirectory: detection.outputDirectory,
  };
}

export function detectedResponse(
  detection: StackDetection,
  commitSha: string,
  explicit: BuildConfig | null,
  applicationRoot = ".",
  pathPrefix = ""
): DetectionResponse {
  const config = detectionToConfig(detection, applicationRoot);
  return {
    status: "detected",
    commitSha,
    detected: {
      config,
      language: detection.language,
      framework: detection.framework,
      confidence: detection.confidence,
      needsReview: detection.needsReview,
      evidence: evidence(detection.evidence, pathPrefix),
      suggestions: suggestions(detection.suggestions),
    },
    ambiguous: null,
    unsupported: null,
    explicit,
    effective: resolveEffectiveConfig(explicit, config),
    explicitIssues: [],
  };
}

export function ambiguousResponse(
  error: StackDetectorError,
  commitSha: string,
  explicit: BuildConfig | null,
  pathPrefix = ""
): DetectionResponse {
  const candidates = error.candidates
    .slice(0, MAX_CANDIDATES)
    .map((candidate) => boundText(pathPrefix ? `${pathPrefix}/${candidate}` : candidate));
  return {
    status: "ambiguous",
    commitSha,
    detected: null,
    ambiguous: {
      code: error.code,
      message: boundText(error.message),
      candidates,
    },
    unsupported: null,
    explicit,
    effective: resolveEffectiveConfig(explicit, null),
    explicitIssues: [],
  };
}

export function unsupportedResponse(
  error: StackDetectorError,
  commitSha: string,
  explicit: BuildConfig | null
): DetectionResponse {
  return {
    status: "unsupported",
    commitSha,
    detected: null,
    ambiguous: null,
    unsupported: { code: error.code, message: boundText(error.message) },
    explicit,
    effective: resolveEffectiveConfig(explicit, null),
    explicitIssues: [],
  };
}

interface DetectionContext {
  workspace: string;
  applicationRoot: string;
  pathPrefix: string;
  explicitIssues: string[];
}

function detectionContext(workspace: string, explicit: BuildConfig | null): DetectionContext {
  if (!explicit) {
    return { workspace, applicationRoot: ".", pathPrefix: "", explicitIssues: [] };
  }
  try {
    const validated = validateBuildConfigAgainstWorkspace(workspace, explicit);
    return {
      workspace: validated.applicationRootAbsolute,
      applicationRoot: explicit.applicationRoot,
      pathPrefix: explicit.applicationRoot === "." ? "" : explicit.applicationRoot,
      explicitIssues: [],
    };
  } catch (error) {
    if (error instanceof BuildConfigError) {
      return {
        workspace,
        applicationRoot: ".",
        pathPrefix: "",
        explicitIssues: [`${error.code}: ${error.message}`.slice(0, MAX_TEXT)],
      };
    }
    throw error;
  }
}

export function runDetectionInWorkspace(
  workspace: string,
  commitSha: string,
  explicitInput: BuildConfig | null
): DetectionResponse {
  const explicit = explicitInput ? parseBuildConfig(explicitInput) : null;
  const context = detectionContext(workspace, explicit);

  try {
    const response = detectedResponse(
      detectStack(context.workspace),
      commitSha,
      explicit,
      context.applicationRoot,
      context.pathPrefix
    );
    return { ...response, explicitIssues: context.explicitIssues };
  } catch (error) {
    if (!(error instanceof StackDetectorError)) throw error;
    const response =
      error.code === "PREFLIGHT_NEEDS_CONFIG"
        ? ambiguousResponse(error, commitSha, explicit, context.pathPrefix)
        : unsupportedResponse(error, commitSha, explicit);
    return { ...response, explicitIssues: context.explicitIssues };
  }
}

export interface DetectionProjectRow {
  id: string;
  repository_url: string;
  branch: string;
}

export interface DetectionDependencies {
  loadProject?: (projectId: string) => Promise<DetectionProjectRow | null>;
  resolveToken?: (projectId: string) => Promise<string | undefined>;
  withWorkspace?: typeof withCheckedOutRepository;
  timeoutMs?: number;
  loadExplicitConfig?: (projectId: string) => Promise<BuildConfig | null>;
}

const timeoutMs = (): number => {
  const raw = Number(process.env.DEPLOYKIT_DETECTION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0
    ? Math.min(Math.max(raw, 5_000), 120_000)
    : 60_000;
};

async function loadProject(projectId: string): Promise<DetectionProjectRow | null> {
  const result = await pool.query(
    `SELECT id, repository_url, branch FROM projects WHERE id = $1`,
    [projectId]
  );
  return (result.rows[0] as DetectionProjectRow | undefined) ?? null;
}

async function resolveToken(projectId: string): Promise<string | undefined> {
  try {
    const result = await pool.query(
      `SELECT i.github_installation_id
         FROM projects p
         JOIN github_repositories r ON r.id = p.github_repository_id
         JOIN github_installations i ON i.id = r.installation_id
        WHERE p.id = $1`,
      [projectId]
    );
    const installationId = result.rows[0]?.github_installation_id;
    if (installationId == null) return undefined;
    const { getInstallationToken } = await import(
      "../infrastructure/github/githubAuth.js"
    );
    return await getInstallationToken(String(installationId));
  } catch {
    return undefined;
  }
}

async function loadExplicitConfig(projectId: string): Promise<BuildConfig | null> {
  return (await getProjectBuildConfig(projectId))?.config ?? null;
}

export async function detectProjectById(
  projectId: string,
  deps: DetectionDependencies = {}
): Promise<DetectionResponse> {
  const project = await (deps.loadProject ?? loadProject)(projectId);
  if (!project) {
    throw new BuildConfigError("PROJECT_NOT_FOUND", "Project not found", 404);
  }

  const explicit = await (deps.loadExplicitConfig ?? loadExplicitConfig)(projectId);
  const authToken = await (deps.resolveToken ?? resolveToken)(projectId);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? timeoutMs()
  );

  try {
    return await (deps.withWorkspace ?? withCheckedOutRepository)(
      {
        repositoryUrl: project.repository_url,
        branch: project.branch,
        authToken,
        signal: controller.signal,
      },
      ({ workspace, commitSha }) =>
        Promise.resolve(runDetectionInWorkspace(workspace, commitSha, explicit))
    );
  } finally {
    clearTimeout(timer);
  }
}
