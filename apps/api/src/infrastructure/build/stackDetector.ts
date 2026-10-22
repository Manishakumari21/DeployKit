import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type StackKind =
  | "dockerfile"
  | "node"
  | "python"
  | "rust"
  | "static"
  | "needs-config";

export type Confidence = "high" | "medium" | "low";

export type Language = "dockerfile" | "node" | "python" | "rust" | "static" | "unknown";

export type Framework =
  | "vite"
  | "next"
  | "cra"
  | "flask"
  | "fastapi"
  | "static-site"
  | "none";

export type EvidenceType =
  | "manifest"
  | "lockfile"
  | "config"
  | "marker"
  | "script"
  | "dependency"
  | "content";

export interface DetectionEvidence {
  /** Repository-relative file the evidence came from, or a logical label. */
  readonly file: string;
  /** An observed fact, never an inference. */
  readonly fact: string;
  readonly type: EvidenceType;
}

export interface DetectionSuggestion {
  readonly field: "buildCommand" | "startCommand" | "outputDirectory";
  readonly value: string;
  /** Why this value is proposed; always tied to detected evidence. */
  readonly basis: string;
  readonly confidence: Confidence;
}

export interface StackDetection {
  kind: StackKind;
  hasDockerfile: boolean;
  packageManager: string | null;
  detail: string;
  // Stage 1 additions below. All additive: existing callers read only the
  // four fields above, so they are unaffected.
  language: Language;
  framework: Framework;
  /** Observed from package.json scripts.build. Never invented. */
  buildCommand: string | null;
  /** Observed from package.json scripts.start. Never invented. */
  startCommand: string | null;
  /** Observed from framework config (vite outDir / next distDir). Never invented. */
  outputDirectory: string | null;
  /** Strictly observed facts. */
  evidence: DetectionEvidence[];
  /** Clearly-labelled proposals. Never auto-applied; require user confirmation. */
  suggestions: DetectionSuggestion[];
  confidence: Confidence;
  /** True whenever the project cannot be built without explicit configuration. */
  needsReview: boolean;
}

export class StackDetectorError extends Error {
  readonly code: string;
  /** Candidate application roots for monorepo layouts. Never auto-selected. */
  readonly candidates: string[];
  constructor(code: string, message: string, candidates: string[] = []) {
    super(message);
    this.name = "StackDetectorError";
    this.code = code;
    this.candidates = candidates;
  }
}

const NODE_LOCKFILES: Array<{ file: string; manager: string }> = [
  { file: "package-lock.json", manager: "npm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "bun.lockb", manager: "bun" },
  { file: "bun.lock", manager: "bun" },
];

const MANAGER_TO_LOCKFILE: Record<string, string> = {
  npm: "package-lock.json",
  yarn: "yarn.lock",
  pnpm: "pnpm-lock.yaml",
  bun: "bun.lockb",
};

const MONOREPO_MARKERS = [
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "turbo.json",
];

const PYTHON_MARKERS = [
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "poetry.lock",
];

const VITE_CONFIGS = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
];

const NEXT_CONFIGS = ["next.config.js", "next.config.mjs", "next.config.ts"];

const PYTHON_APP_FILES = ["app.py", "main.py", "wsgi.py", "server.py", "application.py"];

const PYTHON_REQ_FILES = ["requirements.txt", "pyproject.toml", "Pipfile"];

const MAX_ROOT_ENTRIES = 2000;
const MAX_SUBDIRS_SCANNED = 50;
/** Refuse to read repository files larger than this during detection. */
const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  ".cache",
]);

function isRegularFile(candidate: string): boolean {
  try {
    return lstatSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isSymlink(candidate: string): boolean {
  try {
    return lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Statically read a bounded slice of a repository file. Symlinks and oversized
 * files are treated as absent. Never executes anything.
 */
function readBounded(candidate: string, maxBytes: number = MAX_FILE_BYTES): string | null {
  try {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (stat.size > maxBytes) return null;
    return readFileSync(candidate, "utf8");
  } catch {
    return null;
  }
}

function rootEntries(workspace: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(workspace);
  } catch (error) {
    throw new StackDetectorError(
      "PREFLIGHT_CHECK_FAILED",
      `Preflight could not read the checked-out repository: ${
        error instanceof Error ? error.message : "unknown filesystem error"
      }`.slice(0, 300)
    );
  }
  return entries.slice(0, MAX_ROOT_ENTRIES);
}

interface NestedIndicators {
  nestedPackageJson: boolean;
  nestedDockerfile: boolean;
  monorepoMarker: string | null;
  /** Repository-relative candidate app roots (dirs with package.json/Dockerfile). */
  candidates: string[];
}

function findNestedIndicators(workspace: string, root: Set<string>): NestedIndicators {
  let marker: string | null = null;
  for (const name of MONOREPO_MARKERS) {
    if (root.has(name)) {
      marker = name;
      break;
    }
  }
  let nestedPackageJson = false;
  let nestedDockerfile = false;
  const candidates = new Set<string>();
  let scanned = 0;
  const queue: Array<{ dir: string; depth: number }> = [];
  for (const name of root) {
    if (scanned >= MAX_SUBDIRS_SCANNED) break;
    if (name.startsWith(".")) continue;
    const full = path.join(workspace, name);
    let isDir = false;
    try {
      isDir = lstatSync(full).isDirectory() && !lstatSync(full).isSymbolicLink();
    } catch {
      continue;
    }
    if (isDir && !SKIP_DIRS.has(name)) {
      queue.push({ dir: full, depth: 1 });
      scanned += 1;
    }
  }
  while (queue.length > 0) {
    const current = queue.shift() as { dir: string; depth: number };
    let children: string[];
    try {
      children = readdirSync(current.dir).slice(0, 200);
    } catch {
      continue;
    }
    for (const child of children) {
      const full = path.join(current.dir, child);
      if (child === "package.json" && isRegularFile(full)) {
        nestedPackageJson = true;
        candidates.add(path.relative(workspace, current.dir));
      }
      if (child === "Dockerfile" && isRegularFile(full)) {
        nestedDockerfile = true;
        candidates.add(path.relative(workspace, current.dir));
      }
      if (
        current.depth < 2 &&
        scanned < MAX_SUBDIRS_SCANNED &&
        !child.startsWith(".") &&
        !SKIP_DIRS.has(child)
      ) {
        try {
          const st = lstatSync(full);
          if (st.isDirectory() && !st.isSymbolicLink()) {
            queue.push({ dir: full, depth: current.depth + 1 });
            scanned += 1;
          }
        } catch {
          continue;
        }
      }
    }
  }
  return {
    nestedPackageJson,
    nestedDockerfile,
    monorepoMarker: marker,
    candidates: [...candidates].sort(),
  };
}

interface PackageJsonData {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

function readPackageJson(
  workspace: string
): { data: PackageJsonData | null; evidence: DetectionEvidence[] } {
  const file = path.join(workspace, "package.json");
  if (!isRegularFile(file)) return { data: null, evidence: [] };
  const raw = readBounded(file);
  if (raw === null) {
    return {
      data: null,
      evidence: [
        { file: "package.json", fact: "package.json present but unreadable or oversized", type: "manifest" },
      ],
    };
  }
  try {
    const parsed = JSON.parse(raw) as PackageJsonData;
    return {
      data: parsed && typeof parsed === "object" ? parsed : null,
      evidence: [{ file: "package.json", fact: "package.json present", type: "manifest" }],
    };
  } catch {
    return {
      data: null,
      evidence: [
        { file: "package.json", fact: "package.json present but not valid JSON", type: "manifest" },
      ],
    };
  }
}

function firstExisting(workspace: string, names: string[]): string | null {
  for (const name of names) {
    if (isRegularFile(path.join(workspace, name))) return name;
  }
  return null;
}

function detectNodeFramework(
  workspace: string,
  pkg: PackageJsonData | null,
  evidence: DetectionEvidence[]
): Framework {
  const deps: Record<string, unknown> = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };

  const nextConfig = firstExisting(workspace, NEXT_CONFIGS);
  const hasNextDep = "next" in deps;
  if (nextConfig) {
    evidence.push({ file: nextConfig, fact: "Next.js config file present", type: "config" });
  }
  if (hasNextDep) {
    evidence.push({ file: "package.json", fact: 'dependency "next" present', type: "dependency" });
  }
  if (nextConfig || hasNextDep) return "next";

  const viteConfig = firstExisting(workspace, VITE_CONFIGS);
  const hasViteDep = "vite" in deps;
  if (viteConfig) {
    evidence.push({ file: viteConfig, fact: "Vite config file present", type: "config" });
  }
  if (hasViteDep) {
    evidence.push({ file: "package.json", fact: 'dependency "vite" present', type: "dependency" });
  }
  if (viteConfig || hasViteDep) return "vite";

  const hasReactScripts = "react-scripts" in deps;
  if (hasReactScripts) {
    evidence.push({
      file: "package.json",
      fact: 'dependency "react-scripts" present',
      type: "dependency",
    });
    return "cra";
  }

  return "none";
}

/** Only returns an output directory that is explicitly configured. Never guesses. */
function detectOutputDirectory(
  workspace: string,
  framework: Framework,
  evidence: DetectionEvidence[]
): string | null {
  if (framework === "vite") {
    const cfg = firstExisting(workspace, VITE_CONFIGS);
    if (cfg) {
      const content = readBounded(path.join(workspace, cfg));
      const match = content?.match(/outDir\s*:\s*['"`]([^'"`]+)['"`]/);
      if (match) {
        evidence.push({ file: cfg, fact: `build.outDir = "${match[1]}"`, type: "config" });
        return match[1];
      }
    }
  } else if (framework === "next") {
    const cfg = firstExisting(workspace, NEXT_CONFIGS);
    if (cfg) {
      const content = readBounded(path.join(workspace, cfg));
      const match = content?.match(/distDir\s*:\s*['"`]([^'"`]+)['"`]/);
      if (match) {
        evidence.push({ file: cfg, fact: `distDir = "${match[1]}"`, type: "config" });
        return match[1];
      }
    }
  }
  return null;
}

function buildNodeSuggestions(
  framework: Framework,
  buildCommand: string | null,
  startCommand: string | null,
  outputDirectory: string | null
): DetectionSuggestion[] {
  const suggestions: DetectionSuggestion[] = [];
  if (framework === "vite") {
    if (!buildCommand) {
      suggestions.push({
        field: "buildCommand",
        value: "vite build",
        basis: "Vite framework detected; conventional build command",
        confidence: "medium",
      });
    }
    if (outputDirectory === null) {
      suggestions.push({
        field: "outputDirectory",
        value: "dist",
        basis: "Vite conventional output directory",
        confidence: "medium",
      });
    }
  } else if (framework === "next") {
    if (!buildCommand) {
      suggestions.push({
        field: "buildCommand",
        value: "next build",
        basis: "Next.js framework detected; conventional build command",
        confidence: "medium",
      });
    }
    if (!startCommand) {
      suggestions.push({
        field: "startCommand",
        value: "next start",
        basis: "Next.js framework detected; conventional production start command",
        confidence: "medium",
      });
    }
    if (outputDirectory === null) {
      suggestions.push({
        field: "outputDirectory",
        value: ".next",
        basis: "Next.js conventional output directory",
        confidence: "medium",
      });
    }
  } else if (framework === "cra") {
    if (!buildCommand) {
      suggestions.push({
        field: "buildCommand",
        value: "react-scripts build",
        basis: "Create React App detected; conventional build command",
        confidence: "medium",
      });
    }
    if (!startCommand) {
      suggestions.push({
        field: "startCommand",
        value: "react-scripts start",
        basis: "Create React App detected; conventional start command",
        confidence: "medium",
      });
    }
    if (outputDirectory === null) {
      suggestions.push({
        field: "outputDirectory",
        value: "build",
        basis: "Create React App conventional output directory",
        confidence: "medium",
      });
    }
  }
  return suggestions;
}

function detectPythonFramework(
  workspace: string,
  evidence: DetectionEvidence[]
): Framework {
  for (const file of PYTHON_REQ_FILES) {
    const content = readBounded(path.join(workspace, file));
    if (!content) continue;
    const lower = content.toLowerCase();
    if (/\bfastapi\b/.test(lower)) {
      evidence.push({ file, fact: `"fastapi" listed in ${file}`, type: "dependency" });
      return "fastapi";
    }
    if (/\bflask\b/.test(lower)) {
      evidence.push({ file, fact: `"flask" listed in ${file}`, type: "dependency" });
      return "flask";
    }
  }
  for (const file of PYTHON_APP_FILES) {
    const content = readBounded(path.join(workspace, file));
    if (!content) continue;
    const lower = content.toLowerCase();
    if (/from\s+fastapi\s+import|\bimport\s+fastapi\b/.test(lower)) {
      evidence.push({ file, fact: "imports fastapi", type: "content" });
      return "fastapi";
    }
    if (/from\s+flask\s+import|\bimport\s+flask\b/.test(lower)) {
      evidence.push({ file, fact: "imports flask", type: "content" });
      return "flask";
    }
  }
  return "none";
}

function detectedNode(
  workspace: string,
  lockManagers: Set<string>,
  baseEvidence: DetectionEvidence[]
): StackDetection {
  const evidence: DetectionEvidence[] = [...baseEvidence];
  const packageManager = lockManagers.size === 1 ? [...lockManagers][0] : null;
  if (packageManager) {
    evidence.push({
      file: MANAGER_TO_LOCKFILE[packageManager] ?? "lockfile",
      fact: `${packageManager} lockfile present`,
      type: "lockfile",
    });
  }

  const { data: pkg, evidence: pkgEvidence } = readPackageJson(workspace);
  evidence.push(...pkgEvidence);

  const framework = detectNodeFramework(workspace, pkg, evidence);

  const scripts = pkg?.scripts ?? {};
  const buildCommand =
    typeof scripts.build === "string" && scripts.build.trim() ? scripts.build.trim() : null;
  const startCommand =
    typeof scripts.start === "string" && scripts.start.trim() ? scripts.start.trim() : null;
  if (buildCommand) {
    evidence.push({ file: "package.json", fact: `scripts.build present`, type: "script" });
  }
  if (startCommand) {
    evidence.push({ file: "package.json", fact: `scripts.start present`, type: "script" });
  }

  const outputDirectory = detectOutputDirectory(workspace, framework, evidence);
  const suggestions = buildNodeSuggestions(framework, buildCommand, startCommand, outputDirectory);

  let confidence: Confidence;
  if (framework !== "none" && buildCommand) confidence = "high";
  else if (framework !== "none" || buildCommand) confidence = "medium";
  else confidence = "low";

  return {
    kind: "node",
    hasDockerfile: false,
    packageManager,
    detail:
      "Node.js application detected (package.json) without a root Dockerfile; explicit configuration required",
    language: "node",
    framework,
    buildCommand,
    startCommand,
    outputDirectory,
    evidence,
    suggestions,
    confidence,
    needsReview: true,
  };
}

export function detectStack(workspace: string): StackDetection {
  const root = new Set(rootEntries(workspace));
  const dockerfilePath = path.join(workspace, "Dockerfile");

  if (isSymlink(dockerfilePath)) {
    throw new StackDetectorError(
      "PREFLIGHT_UNSAFE_PATH",
      "Dockerfile must be a regular file, not a symlink"
    );
  }
  const hasDockerfile = isRegularFile(dockerfilePath);

  const hasPackageJson = isRegularFile(path.join(workspace, "package.json"));
  const lockManagers = new Set<string>();
  for (const { file, manager } of NODE_LOCKFILES) {
    if (isRegularFile(path.join(workspace, file))) lockManagers.add(manager);
  }
  const pythonMarkers = PYTHON_MARKERS.filter((name) =>
    isRegularFile(path.join(workspace, name))
  );
  const hasCargoToml = isRegularFile(path.join(workspace, "Cargo.toml"));
  const hasIndexHtml = isRegularFile(path.join(workspace, "index.html"));

  if (hasDockerfile) {
    const evidence: DetectionEvidence[] = [
      { file: "Dockerfile", fact: "Dockerfile present at repository root", type: "config" },
    ];
    const packageManager = lockManagers.size === 1 ? [...lockManagers][0] : null;
    if (packageManager) {
      evidence.push({
        file: MANAGER_TO_LOCKFILE[packageManager] ?? "lockfile",
        fact: `${packageManager} lockfile present`,
        type: "lockfile",
      });
    }
    const { data: pkg, evidence: pkgEvidence } = readPackageJson(workspace);
    evidence.push(...pkgEvidence);
    const framework = detectNodeFramework(workspace, pkg, evidence);
    return {
      kind: "dockerfile",
      hasDockerfile: true,
      packageManager,
      detail: "Dockerfile-based application",
      language: "dockerfile",
      framework,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      evidence,
      suggestions: [],
      confidence: "high",
      needsReview: false,
    };
  }

  if (lockManagers.size > 1) {
    throw new StackDetectorError(
      "PREFLIGHT_CONFLICTING_LOCKFILES",
      `Conflicting package-manager lockfiles (${[...lockManagers].sort().join(", ")}); commit to a single package manager`
    );
  }

  const nested = findNestedIndicators(workspace, root);
  if (
    nested.monorepoMarker !== null ||
    (nested.nestedPackageJson && hasPackageJson) ||
    nested.nestedDockerfile
  ) {
    throw new StackDetectorError(
      "PREFLIGHT_NEEDS_CONFIG",
      "Monorepo or multi-service layout detected; set an explicit project build configuration",
      nested.candidates
    );
  }

  if (hasPackageJson) {
    return detectedNode(workspace, lockManagers, []);
  }

  if (pythonMarkers.length > 0) {
    const evidence: DetectionEvidence[] = pythonMarkers.map((name) => ({
      file: name,
      fact: `Python project file ${name} present`,
      type: "marker" as const,
    }));
    const framework = detectPythonFramework(workspace, evidence);
    return {
      kind: "python",
      hasDockerfile: false,
      packageManager: null,
      detail: `Python application detected (${pythonMarkers[0]}) without a root Dockerfile; explicit configuration required`,
      language: "python",
      framework,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      evidence,
      suggestions: [],
      confidence: framework !== "none" ? "medium" : "low",
      needsReview: true,
    };
  }

  if (hasCargoToml) {
    return {
      kind: "rust",
      hasDockerfile: false,
      packageManager: "cargo",
      detail:
        "Rust application detected (Cargo.toml) without a root Dockerfile; explicit configuration required",
      language: "rust",
      framework: "none",
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      evidence: [
        { file: "Cargo.toml", fact: "Cargo.toml present at repository root", type: "marker" },
      ],
      suggestions: [],
      confidence: "high",
      needsReview: true,
    };
  }

  if (hasIndexHtml) {
    return {
      kind: "static",
      hasDockerfile: false,
      packageManager: null,
      detail: "Static site detected (index.html) without a root Dockerfile; explicit configuration required",
      language: "static",
      framework: "static-site",
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      evidence: [
        { file: "index.html", fact: "index.html present at repository root", type: "marker" },
      ],
      suggestions: [],
      confidence: "high",
      needsReview: true,
    };
  }

  throw new StackDetectorError(
    "PREFLIGHT_MISSING_INPUTS",
    "No Dockerfile, package.json, Python project file, Cargo.toml, or index.html found at the repository root"
  );
}
