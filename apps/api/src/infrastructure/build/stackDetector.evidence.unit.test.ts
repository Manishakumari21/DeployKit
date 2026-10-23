// Phase 02 Stage 1: Smart Project Detection engine — evidence, confidence,
// monorepo candidates, observed-vs-suggested separation, and no-execution.
// These tests are purely filesystem-based and run without a database.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { detectStack, StackDetectorError } from "./stackDetector.js";

function workspace(files: Record<string, string>, dirs: string[] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), "detector-evidence-"));
  for (const dir of dirs) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "no-error";
  } catch (error) {
    return error instanceof StackDetectorError ? error.code : "unexpected-error";
  }
}

function errorOf(fn: () => unknown): StackDetectorError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StackDetectorError) return error;
    throw error;
  }
  throw new Error("expected a StackDetectorError");
}

// --- Vite -------------------------------------------------------------------

test("Vite with config file and dependency is classified with high confidence", () => {
  const dir = workspace({
    "package.json": JSON.stringify({
      name: "vite-app",
      scripts: { build: "vite build", start: "vite preview" },
      devDependencies: { vite: "^5.0.0" },
    }),
    "vite.config.ts": "export default { build: { outDir: 'build-dist' } };",
  });

  const result = detectStack(dir);
  assert.equal(result.kind, "node");
  assert.equal(result.framework, "vite");
  assert.equal(result.language, "node");
  // Observed facts, not inventions:
  assert.equal(result.buildCommand, "vite build");
  assert.equal(result.startCommand, "vite preview");
  // Output directory explicitly configured in vite.config.ts is observed:
  assert.equal(result.outputDirectory, "build-dist");
  assert.equal(result.confidence, "high");
  assert.ok(result.evidence.some((e) => e.file === "vite.config.ts"));
  // buildCommand is present so no buildCommand suggestion should be proposed.
  assert.ok(!result.suggestions.some((s) => s.field === "buildCommand"));
});

test("Vite detected from config file alone (no dependency entry)", () => {
  const dir = workspace({
    "package.json": JSON.stringify({ name: "app", scripts: { build: "vite build" } }),
    "vite.config.js": "export default {};",
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "vite");
  assert.ok(result.evidence.some((e) => e.file === "vite.config.js" && e.type === "config"));
});

test("Vite detected from dependency alone (no config file), medium confidence", () => {
  const dir = workspace({
    "package.json": JSON.stringify({
      name: "app",
      devDependencies: { vite: "^5.0.0" },
    }),
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "vite");
  assert.equal(result.buildCommand, null); // no scripts.build → never invented
  // Conventional value is offered strictly as a suggestion:
  assert.ok(result.suggestions.some((s) => s.field === "buildCommand" && s.value === "vite build"));
  assert.ok(result.suggestions.every((s) => typeof s.basis === "string" && s.basis.length > 0));
  assert.equal(result.confidence, "medium");
});

test("Vite conventional output directory is suggested, never observed", () => {
  const dir = workspace({
    "package.json": JSON.stringify({ name: "app", scripts: { build: "vite build" } }),
    "vite.config.js": "export default {};",
  });

  const result = detectStack(dir);
  assert.equal(result.outputDirectory, null); // not configured → not invented
  assert.ok(result.suggestions.some((s) => s.field === "outputDirectory" && s.value === "dist"));
});

// --- Next.js ----------------------------------------------------------------

test("Next.js with config file and dependency is classified", () => {
  const dir = workspace({
    "package.json": JSON.stringify({
      name: "next-app",
      scripts: { build: "next build", start: "next start" },
      dependencies: { next: "^14.0.0", react: "^18.0.0" },
    }),
    "next.config.js": "module.exports = {};",
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "next");
  assert.equal(result.buildCommand, "next build");
  assert.equal(result.startCommand, "next start");
  assert.equal(result.outputDirectory, null); // .next is convention → suggestion
  assert.ok(result.suggestions.some((s) => s.field === "outputDirectory" && s.value === ".next"));
  assert.ok(result.evidence.some((e) => e.file === "next.config.js"));
});

test("Next.js distDir in config is observed as output directory", () => {
  const dir = workspace({
    "package.json": JSON.stringify({ name: "app", dependencies: { next: "^14.0.0" } }),
    "next.config.js": "module.exports = { distDir: '.custom-next' };",
  });

  const result = detectStack(dir);
  assert.equal(result.outputDirectory, ".custom-next");
});

test("Next.js detected from dependency alone (no config file)", () => {
  const dir = workspace({
    "package.json": JSON.stringify({ name: "app", dependencies: { next: "^14.0.0" } }),
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "next");
  assert.equal(result.buildCommand, null);
  assert.ok(result.suggestions.some((s) => s.field === "buildCommand" && s.value === "next build"));
  assert.ok(result.suggestions.some((s) => s.field === "startCommand" && s.value === "next start"));
});

// --- Create React App -------------------------------------------------------

test("Create React App classified from react-scripts dependency", () => {
  const dir = workspace({
    "package.json": JSON.stringify({
      name: "cra-app",
      scripts: { build: "react-scripts build", start: "react-scripts start" },
      dependencies: { "react-scripts": "5.0.1", react: "^18.0.0" },
    }),
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "cra");
  assert.equal(result.buildCommand, "react-scripts build");
  assert.equal(result.startCommand, "react-scripts start");
  assert.equal(result.outputDirectory, null);
  assert.ok(result.suggestions.some((s) => s.field === "outputDirectory" && s.value === "build"));
});

test("Vite is classified from a direct package.json script when dependency metadata is absent", () => {
  const dir = workspace({
    "package.json": JSON.stringify({
      name: "app",
      scripts: { build: "vite build", start: "vite preview" },
    }),
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "vite");
  assert.equal(result.buildCommand, "vite build");
  assert.ok(
    result.evidence.some(
      (entry) => entry.file === "package.json" && entry.type === "script" && entry.fact.includes("vite")
    )
  );
});

test("quoted framework text in a script is not treated as a direct command", () => {
  const dir = workspace({
    "package.json": JSON.stringify({
      name: "app",
      scripts: { build: 'echo "prepare && vite build"' },
    }),
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "none");
});

test("bun.lock evidence names the lockfile that actually exists", () => {
  const dir = workspace({
    "package.json": JSON.stringify({ name: "app" }),
    "bun.lock": "",
  });

  const result = detectStack(dir);
  assert.equal(result.packageManager, "bun");
  assert.ok(
    result.evidence.some(
      (entry) => entry.type === "lockfile" && entry.file === "bun.lock"
    )
  );
  assert.ok(
    !result.evidence.some(
      (entry) => entry.type === "lockfile" && entry.file === "bun.lockb"
    )
  );
});

// --- Flask / FastAPI ---------------------------------------------------------

test("Flask classified from requirements.txt dependency", () => {
  const dir = workspace({
    "requirements.txt": "flask>=2.0\nWerkzeug>=2.0\n",
  });

  const result = detectStack(dir);
  assert.equal(result.kind, "python");
  assert.equal(result.framework, "flask");
  assert.equal(result.language, "python");
  assert.ok(result.evidence.some((e) => e.file === "requirements.txt" && e.type === "dependency"));
  // Python start commands are not invented (module:app name is unknowable statically).
  assert.equal(result.buildCommand, null);
  assert.equal(result.startCommand, null);
  assert.equal(result.suggestions.length, 0);
});

test("Flask classified from source import when requirements.txt lists no framework", () => {
  const dir = workspace({
    "requirements.txt": "# no framework pinned here\n",
    "app.py": "from flask import Flask\napp = Flask(__name__)\n",
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "flask");
  assert.ok(result.evidence.some((e) => e.file === "app.py" && e.fact === "imports flask"));
});

test("FastAPI classified from pyproject.toml dependency", () => {
  const dir = workspace({
    "pyproject.toml": '[project]\nname = "svc"\ndependencies = ["fastapi", "uvicorn"]\n',
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "fastapi");
  assert.ok(result.evidence.some((e) => e.file === "pyproject.toml" && e.type === "dependency"));
});

test("FastAPI classified from source import when requirements.txt lists no framework", () => {
  const dir = workspace({
    "requirements.txt": "# no framework pinned here\n",
    "main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "fastapi");
  assert.ok(result.evidence.some((e) => e.file === "main.py" && e.fact === "imports fastapi"));
});

test("commented Python dependencies are not treated as framework evidence", () => {
  const dir = workspace({
    "requirements.txt": "# fastapi is intentionally disabled\nflask>=2.0\n",
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "flask");
  assert.ok(!result.evidence.some((e) => e.fact.includes('"fastapi"')));
});

test("a pyproject description mentioning fastapi is not a dependency", () => {
  const dir = workspace({
    "pyproject.toml":
      '[project]\nname = "svc"\ndescription = "fastapi service"\ndependencies = []\n',
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "none");
});

test("commented Python imports are not treated as framework evidence", () => {
  const dir = workspace({
    "requirements.txt": "# no framework pinned here\n",
    "app.py": "# import fastapi\n# from flask import Flask\n",
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "none");
});

test("Pipfile dependencies are parsed by package section", () => {
  const dir = workspace({
    Pipfile: '[packages]\nfastapi = "*"\n\n[dev-packages]\n# flask = "*"\n',
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "fastapi");
  assert.ok(result.evidence.some((e) => e.file === "Pipfile" && e.type === "dependency"));
});

// --- Rust -------------------------------------------------------------------

test("Rust classified from Cargo.toml with high confidence", () => {
  const dir = workspace({
    "Cargo.toml": '[package]\nname = "svc"\nversion = "0.1.0"\n',
  });

  const result = detectStack(dir);
  assert.equal(result.kind, "rust");
  assert.equal(result.language, "rust");
  assert.equal(result.packageManager, "cargo");
  assert.equal(result.confidence, "high");
  assert.equal(result.needsReview, true); // no Dockerfile → needs config
  assert.ok(result.evidence.some((e) => e.file === "Cargo.toml" && e.type === "marker"));
  // cargo build --release is a convention, not observed from the repo:
  assert.equal(result.buildCommand, null);
});

// --- Static sites -----------------------------------------------------------

test("Static site exposes framework static-site and needs review", () => {
  const dir = workspace({ "index.html": "<!doctype html><title>hi</title>" });

  const result = detectStack(dir);
  assert.equal(result.kind, "static");
  assert.equal(result.framework, "static-site");
  assert.equal(result.language, "static");
  assert.equal(result.confidence, "high");
  assert.equal(result.needsReview, true);
  assert.equal(result.buildCommand, null);
});

// --- Observed facts vs. suggestions ----------------------------------------

test("Observed build command is never duplicated as a suggestion", () => {
  const dir = workspace({
    "package.json": JSON.stringify({
      name: "app",
      scripts: { build: "custom-build.sh" },
      devDependencies: { vite: "^5.0.0" },
    }),
  });

  const result = detectStack(dir);
  assert.equal(result.buildCommand, "custom-build.sh");
  // Since buildCommand is observed, no buildCommand suggestion must be emitted.
  assert.ok(!result.suggestions.some((s) => s.field === "buildCommand"));
});

test("No framework and no scripts → no commands invented, empty suggestions", () => {
  const dir = workspace({
    "package.json": JSON.stringify({ name: "app" }),
  });

  const result = detectStack(dir);
  assert.equal(result.framework, "none");
  assert.equal(result.buildCommand, null);
  assert.equal(result.startCommand, null);
  assert.equal(result.outputDirectory, null);
  assert.equal(result.suggestions.length, 0);
  assert.equal(result.confidence, "low");
  assert.equal(result.needsReview, true);
});

test("Unparseable package.json degrades gracefully without guessing", () => {
  const dir = workspace({ "package.json": "{ this is not json" });

  const result = detectStack(dir);
  assert.equal(result.kind, "node");
  assert.equal(result.framework, "none");
  assert.equal(result.buildCommand, null);
  assert.equal(result.suggestions.length, 0);
  assert.ok(result.evidence.some((e) => e.fact.includes("not valid JSON")));
});

// --- Evidence structure ------------------------------------------------------

test("Evidence entries expose file, fact, and type", () => {
  const dir = workspace({
    "package.json": JSON.stringify({
      name: "app",
      scripts: { build: "vite build" },
      devDependencies: { vite: "^5.0.0" },
    }),
    "vite.config.ts": "export default {};",
  });

  const result = detectStack(dir);
  assert.ok(result.evidence.length > 0);
  for (const entry of result.evidence) {
    assert.ok(typeof entry.file === "string" && entry.file.length > 0);
    assert.ok(typeof entry.fact === "string" && entry.fact.length > 0);
    assert.ok(typeof entry.type === "string");
  }
  assert.ok(result.evidence.some((e) => e.type === "script" && e.fact === "scripts.build present"));
});

test("Evidence never contains full file contents, only bounded facts", () => {
  const secretMarker = "SUPER_SECRET_VALUE_SHOULD_NOT_APPEAR";
  const dir = workspace({
    "package.json": JSON.stringify({ name: "app" }),
    "app.py": `from flask import Flask\nSECRET = "${secretMarker}"\n`,
  });

  const result = detectStack(dir);
  const serialized = JSON.stringify(result.evidence);
  assert.ok(!serialized.includes(secretMarker));
});

// --- Monorepo candidates -----------------------------------------------------

test("Monorepo with nested app roots reports candidates and never selects one", () => {
  const dir = workspace({
    "package.json": JSON.stringify({ name: "root" }),
    "apps/web/package.json": JSON.stringify({ name: "web" }),
    "packages/api/package.json": JSON.stringify({ name: "api" }),
  });

  const err = errorOf(() => detectStack(dir));
  assert.equal(err.code, "PREFLIGHT_NEEDS_CONFIG");
  assert.ok(err.candidates.includes("apps/web"));
  assert.ok(err.candidates.includes("packages/api"));
  // No project was auto-selected — detection still refuses to proceed.
  assert.equal(codeOf(() => detectStack(dir)), "PREFLIGHT_NEEDS_CONFIG");
});

test("Nested app roots without a root package.json are ambiguous with candidates", () => {
  const dir = workspace({
    "apps/web/package.json": JSON.stringify({ name: "web" }),
    "services/api/package.json": JSON.stringify({ name: "api" }),
  });

  const err = errorOf(() => detectStack(dir));
  assert.equal(err.code, "PREFLIGHT_NEEDS_CONFIG");
  assert.deepEqual(err.candidates, ["apps/web", "services/api"]);
});

test("pnpm workspace marker triggers NEEDS_CONFIG", () => {
  const dir = workspace({
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
  });

  const err = errorOf(() => detectStack(dir));
  assert.equal(err.code, "PREFLIGHT_NEEDS_CONFIG");
});

test("Candidates are absent (empty) for non-monorepo errors", () => {
  const dir = workspace({});
  const err = errorOf(() => detectStack(dir));
  assert.equal(err.code, "PREFLIGHT_MISSING_INPUTS");
  assert.equal(err.candidates.length, 0);
});

// --- No script execution -----------------------------------------------------

test("Detection never executes repository scripts", () => {
  const markerName = "EXECUTED_MARKER.txt";
  const dir = workspace({
    "package.json": JSON.stringify({
      name: "app",
      scripts: {
        build: `node -e "require('fs').writeFileSync('${markerName}','ran')"`,
        preinstall: `node -e "require('fs').writeFileSync('${markerName}','ran')"`,
      },
    }),
  });

  const result = detectStack(dir);
  // The script is observed, not run:
  assert.equal(result.buildCommand, `node -e "require('fs').writeFileSync('${markerName}','ran')"`);
  // And nothing was executed — the marker file does not exist.
  assert.throws(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { lstatSync } = require("node:fs") as typeof import("node:fs");
    lstatSync(path.join(dir, markerName));
  });
});

test("Symlinked framework config is treated as absent, not followed", () => {
  const dir = workspace({
    "package.json": JSON.stringify({ name: "app" }),
  });
  // Create a real config then replace with symlink to prove it is not read.
  const target = path.join(dir, "real-config.js");
  writeFileSync(target, "export default {};");
  const { symlinkSync } = require("node:fs") as typeof import("node:fs");
  symlinkSync(target, path.join(dir, "vite.config.js"));

  const result = detectStack(dir);
  // Symlinked config must be ignored → framework not detected from it.
  assert.equal(result.framework, "none");
});

// --- Backward compatibility of existing behavior -----------------------------

test("Dockerfile still wins over framework detection and is review-free", () => {
  const dir = workspace({
    Dockerfile: "FROM node:20\n",
    "package.json": JSON.stringify({
      name: "app",
      dependencies: { next: "^14.0.0" },
    }),
  });

  const result = detectStack(dir);
  assert.equal(result.kind, "dockerfile");
  assert.equal(result.hasDockerfile, true);
  assert.equal(result.needsReview, false);
  assert.equal(result.confidence, "high");
});

test("Conflicting lockfiles still rejected before framework detection", () => {
  const dir = workspace({
    "package.json": JSON.stringify({ name: "app" }),
    "package-lock.json": "{}",
    "yarn.lock": "",
  });

  assert.equal(codeOf(() => detectStack(dir)), "PREFLIGHT_CONFLICTING_LOCKFILES");
});

test("Dockerfile symlink still rejected as unsafe path", () => {
  const dir = workspace({});
  const { symlinkSync } = require("node:fs") as typeof import("node:fs");
  const target = path.join(dir, "real-Dockerfile");
  writeFileSync(target, "FROM scratch\n");
  symlinkSync(target, path.join(dir, "Dockerfile"));

  assert.equal(codeOf(() => detectStack(dir)), "PREFLIGHT_UNSAFE_PATH");
});
