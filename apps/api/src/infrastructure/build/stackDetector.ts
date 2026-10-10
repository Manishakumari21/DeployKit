import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

export type StackKind =
  | "dockerfile"
  | "node"
  | "python"
  | "static"
  | "needs-config";

export interface StackDetection {
  kind: StackKind;
  hasDockerfile: boolean;
  packageManager: string | null;
  detail: string;
}

export class StackDetectorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StackDetectorError";
    this.code = code;
  }
}

const NODE_LOCKFILES: Array<{ file: string; manager: string }> = [
  { file: "package-lock.json", manager: "npm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "bun.lockb", manager: "bun" },
  { file: "bun.lock", manager: "bun" },
];

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

const MAX_ROOT_ENTRIES = 2000;
const MAX_SUBDIRS_SCANNED = 50;
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

function findNestedIndicators(workspace: string, root: Set<string>): { nestedPackageJson: boolean; nestedDockerfile: boolean; monorepoMarker: string | null } {
  let marker: string | null = null;
  for (const name of MONOREPO_MARKERS) {
    if (root.has(name)) {
      marker = name;
      break;
    }
  }
  let nestedPackageJson = false;
  let nestedDockerfile = false;
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
      if (child === "package.json" && isRegularFile(full)) nestedPackageJson = true;
      if (child === "Dockerfile" && isRegularFile(full)) nestedDockerfile = true;
      if (nestedPackageJson && nestedDockerfile) return { nestedPackageJson, nestedDockerfile, monorepoMarker: marker };
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
    if (nestedPackageJson && nestedDockerfile) break;
  }
  return { nestedPackageJson, nestedDockerfile, monorepoMarker: marker };
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
  const hasIndexHtml = isRegularFile(path.join(workspace, "index.html"));

  if (hasDockerfile) {
    return {
      kind: "dockerfile",
      hasDockerfile: true,
      packageManager: lockManagers.size === 1 ? [...lockManagers][0] : null,
      detail: "Dockerfile-based application",
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
      "Monorepo or multi-service layout detected; set an explicit project build configuration"
    );
  }

  if (hasPackageJson) {
    return {
      kind: "node",
      hasDockerfile: false,
      packageManager: lockManagers.size === 1 ? [...lockManagers][0] : null,
      detail: "Node.js application detected (package.json) without a root Dockerfile; explicit configuration required",
    };
  }

  if (pythonMarkers.length > 0) {
    return {
      kind: "python",
      hasDockerfile: false,
      packageManager: null,
      detail: `Python application detected (${pythonMarkers[0]}) without a root Dockerfile; explicit configuration required`,
    };
  }

  if (hasIndexHtml) {
    return {
      kind: "static",
      hasDockerfile: false,
      packageManager: null,
      detail: "Static site detected (index.html) without a root Dockerfile; explicit configuration required",
    };
  }

  throw new StackDetectorError(
    "PREFLIGHT_MISSING_INPUTS",
    "No Dockerfile, package.json, Python project file, or index.html found at the repository root"
  );
}
