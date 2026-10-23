// Phase 02 Stage 2A: build configuration schema, safe-path validation,
// explicit-vs-detected precedence, bounded detection DTOs, and controller
// response shapes. Purely filesystem-based; no database required.

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createBuildConfigControllers } from "../controllers/buildConfigController.js";
import type { Request, Response } from "express";
import {
  BuildConfigError,
  parseBuildConfig,
  resolveEffectiveConfig,
  validateBuildConfigAgainstWorkspace,
  type BuildConfig,
} from "./buildConfigService.js";
import {
  ambiguousResponse,
  boundText,
  detectedResponse,
  detectionToConfig,
  runDetectionInWorkspace,
  type DetectionResponse,
} from "./projectDetectionService.js";
import { SourceCheckoutError } from "../infrastructure/git/sourceCheckout.js";
import { StackDetectorError, type StackDetection } from "../infrastructure/build/stackDetector.js";

const VALID_ID = "11111111-1111-4111-8111-111111111111";

function workspace(files: Record<string, string>, dirs: string[] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), "build-config-unit-"));
  for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
    return "no-error";
  } catch (error) {
    return error instanceof BuildConfigError ? error.code : "unexpected";
  }
}

function dockerfileConfig(overrides: Record<string, unknown> = {}) {
  return { builder: "dockerfile", dockerfilePath: "Dockerfile", ...overrides };
}

// --- Schema validation ------------------------------------------------------

test("valid Dockerfile config defaults applicationRoot to repository root", () => {
  const config = parseBuildConfig(dockerfileConfig());
  assert.equal(config.applicationRoot, ".");
  assert.equal(config.builder, "dockerfile");
  assert.equal(config.dockerfilePath, "Dockerfile");
  assert.equal(config.buildCommand, null);
});

test("valid Node config accepts observed commands and output directory", () => {
  const config = parseBuildConfig({
    applicationRoot: "apps/web",
    builder: "node",
    buildCommand: "npm run build",
    startCommand: "npm start",
    outputDirectory: "dist",
  });
  assert.equal(config.applicationRoot, "apps/web");
  assert.equal(config.buildCommand, "npm run build");
  assert.equal(config.outputDirectory, "dist");
  assert.equal(config.dockerfilePath, null);
});

test("unknown builder is rejected", () => {
  assert.equal(errorCode(() => parseBuildConfig({ builder: "ruby" })), "INVALID_CONFIG");
});

test("unknown configuration keys are rejected", () => {
  assert.equal(
    errorCode(() => parseBuildConfig({ builder: "node", shellCommand: "rm -rf /" })),
    "INVALID_CONFIG"
  );
});

test("dockerfile builder requires dockerfilePath", () => {
  assert.equal(errorCode(() => parseBuildConfig({ builder: "dockerfile" })), "INVALID_CONFIG");
});

test("non-dockerfile builder rejects dockerfilePath", () => {
  assert.equal(
    errorCode(() => parseBuildConfig({ builder: "node", dockerfilePath: "Dockerfile" })),
    "INVALID_CONFIG"
  );
});

test("absolute, traversal, and backslash paths are rejected", () => {
  for (const applicationRoot of ["/etc", "../outside", "apps/../../etc", "apps\\web", "~/home"]) {
    assert.equal(
      errorCode(() => parseBuildConfig({ builder: "node", applicationRoot })),
      "INVALID_CONFIG",
      `expected ${applicationRoot} to be rejected`
    );
  }
});

test("absolute output directory and traversal are rejected", () => {
  for (const outputDirectory of ["/var/www/html", "../dist", "dist/../../etc"]) {
    assert.equal(
      errorCode(() => parseBuildConfig({ builder: "node", outputDirectory })),
      "INVALID_CONFIG",
      `expected ${outputDirectory} to be rejected`
    );
  }
});

test("control characters in commands are rejected", () => {
  assert.equal(
    errorCode(() => parseBuildConfig({ builder: "node", buildCommand: "npm run build\nrm -rf /" })),
    "INVALID_CONFIG"
  );
});

test("overlong commands are rejected", () => {
  assert.equal(
    errorCode(() => parseBuildConfig({ builder: "node", buildCommand: "x".repeat(2001) })),
    "INVALID_CONFIG"
  );
});

// --- Safe-path validation against a checked-out repository ------------------

test("valid application root and Dockerfile are accepted", () => {
  const root = workspace({ "apps/web/Dockerfile": "FROM node:20\n" }, ["apps/web"]);
  const result = validateBuildConfigAgainstWorkspace(root, {
    applicationRoot: "apps/web",
    builder: "dockerfile",
    dockerfilePath: "Dockerfile",
  });
  assert.equal(result.config.applicationRoot, "apps/web");
  assert.ok(result.dockerfileAbsolute?.endsWith("Dockerfile"));
});

test("Dockerfile path traversal outside the application root is rejected", () => {
  const root = workspace({ "Dockerfile": "FROM node:20\n" }, ["apps/web"]);
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        applicationRoot: "apps/web",
        builder: "dockerfile",
        dockerfilePath: "../Dockerfile",
      })
    ),
    "INVALID_CONFIG"
  );
});

test("missing application root is rejected", () => {
  const root = workspace({});
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, { applicationRoot: "missing", builder: "node" })
    ),
    "PATH_NOT_FOUND"
  );
});

test("application root that is a file is rejected", () => {
  const root = workspace({ app: "not a directory" });
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, { applicationRoot: "app", builder: "node" })
    ),
    "INVALID_PATH"
  );
});

test("missing Dockerfile is rejected", () => {
  const root = workspace({}, ["apps/web"]);
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        applicationRoot: "apps/web",
        builder: "dockerfile",
        dockerfilePath: "Dockerfile",
      })
    ),
    "PATH_NOT_FOUND"
  );
});

test("Dockerfile that is a directory is rejected", () => {
  const root = workspace({}, ["Dockerfile"]);
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, dockerfileConfig())
    ),
    "INVALID_PATH"
  );
});

test("symlinked application root is rejected", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "build-config-outside-"));
  writeFileSync(path.join(outside, "keep.txt"), "x");
  const root = workspace({});
  symlinkSync(outside, path.join(root, "app"), "dir");

  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, { applicationRoot: "app", builder: "node" })
    ),
    "SYMLINK_NOT_ALLOWED"
  );
});

test("symlinked Dockerfile is rejected", () => {
  const root = workspace({});
  writeFileSync(path.join(root, "real-Dockerfile"), "FROM scratch\n");
  symlinkSync(path.join(root, "real-Dockerfile"), path.join(root, "Dockerfile"));

  assert.equal(
    errorCode(() => validateBuildConfigAgainstWorkspace(root, dockerfileConfig())),
    "SYMLINK_NOT_ALLOWED"
  );
});

test("a symlinked parent directory cannot be used to escape", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "build-config-outside-"));
  mkdirSync(path.join(outside, "app"));
  const root = workspace({});
  symlinkSync(outside, path.join(root, "link"), "dir");

  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        applicationRoot: "link/app",
        builder: "node",
      })
    ),
    "SYMLINK_NOT_ALLOWED"
  );
});

test("traversal and absolute paths are rejected by the wrapper too", () => {
  const root = workspace({});
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, { applicationRoot: "../etc", builder: "node" })
    ),
    "INVALID_CONFIG"
  );
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, { applicationRoot: "/etc", builder: "node" })
    ),
    "INVALID_CONFIG"
  );
});

test("missing workspace is reported as unavailable", () => {
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(
        path.join(tmpdir(), `does-not-exist-${Date.now()}`),
        { builder: "node" }
      )
    ),
    "WORKSPACE_UNAVAILABLE"
  );
});

test("output directory may not exist yet but is still lexically contained", () => {
  const root = workspace({ "package.json": "{}" });
  const result = validateBuildConfigAgainstWorkspace(root, {
    builder: "node",
    outputDirectory: "dist",
  });
  assert.equal(result.config.outputDirectory, "dist");
});

test("existing output directory is accepted when it is a real directory", () => {
  const root = workspace({}, ["dist"]);
  const result = validateBuildConfigAgainstWorkspace(root, {
    builder: "node",
    outputDirectory: "dist",
  });
  assert.equal(result.config.outputDirectory, "dist");
});

test("symlinked output directory is rejected", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "build-config-outside-"));
  const root = workspace({});
  symlinkSync(outside, path.join(root, "dist"), "dir");

  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        builder: "node",
        outputDirectory: "dist",
      })
    ),
    "SYMLINK_NOT_ALLOWED"
  );
});

test("missing output nested under a symlinked ancestor is rejected", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "build-config-outside-"));
  const root = workspace({});
  symlinkSync(outside, path.join(root, "link"), "dir");

  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        builder: "node",
        outputDirectory: "link/dist",
      })
    ),
    "SYMLINK_NOT_ALLOWED"
  );
});

test("deeply nested application root and Dockerfile are accepted", () => {
  const root = workspace({
    "apps/web/services/api/Dockerfile": "FROM node:20\n",
  });
  const result = validateBuildConfigAgainstWorkspace(root, {
    applicationRoot: "apps/web/services/api",
    builder: "dockerfile",
    dockerfilePath: "Dockerfile",
  });
  assert.equal(result.config.applicationRoot, "apps/web/services/api");
  assert.ok(
    result.dockerfileAbsolute?.endsWith(
      path.join("apps", "web", "services", "api", "Dockerfile")
    )
  );
});

test("the repository root is accepted as the application root", () => {
  const root = workspace({ "package.json": "{}" });
  const result = validateBuildConfigAgainstWorkspace(root, {
    applicationRoot: ".",
    builder: "node",
  });
  assert.equal(result.applicationRootAbsolute, realpathSync(root));
});

test("missing nested output directory under an existing ancestor is accepted", () => {
  const root = workspace({ "package.json": "{}" }, ["build/assets"]);
  const result = validateBuildConfigAgainstWorkspace(root, {
    builder: "node",
    outputDirectory: "build/assets/static",
  });
  assert.equal(result.config.outputDirectory, "build/assets/static");
});

test("output directory nested under a file is rejected", () => {
  const root = workspace({ build: "not a directory" });
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        builder: "node",
        outputDirectory: "build/assets",
      })
    ),
    "INVALID_PATH"
  );
});

test("existing output directory that is a file is rejected", () => {
  const root = workspace({ dist: "not a directory" });
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        builder: "node",
        outputDirectory: "dist",
      })
    ),
    "INVALID_PATH"
  );
});

test("nested Dockerfile under a file is rejected", () => {
  const root = workspace({ "apps/web/sub": "not a directory" }, ["apps/web"]);
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        applicationRoot: "apps/web",
        builder: "dockerfile",
        dockerfilePath: "sub/Dockerfile",
      })
    ),
    "INVALID_PATH"
  );
});

test("symlinked intermediate directory is rejected for a nested Dockerfile", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "build-config-outside-"));
  writeFileSync(path.join(outside, "Dockerfile"), "FROM scratch\n");
  const root = workspace({}, ["apps/web"]);
  symlinkSync(outside, path.join(root, "apps/web/sub"), "dir");

  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        applicationRoot: "apps/web",
        builder: "dockerfile",
        dockerfilePath: "sub/Dockerfile",
      })
    ),
    "SYMLINK_NOT_ALLOWED"
  );
});

test("symlinked intermediate directory is rejected for a missing nested output", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "build-config-outside-"));
  const root = workspace({}, ["build"]);
  symlinkSync(outside, path.join(root, "build/cache"), "dir");

  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        builder: "node",
        outputDirectory: "build/cache/assets",
      })
    ),
    "SYMLINK_NOT_ALLOWED"
  );
});

test("a symlink pointing inside the workspace is still rejected", () => {
  const root = workspace({}, ["real"]);
  symlinkSync(path.join(root, "real"), path.join(root, "link"), "dir");

  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        applicationRoot: "link",
        builder: "node",
      })
    ),
    "SYMLINK_NOT_ALLOWED"
  );
});

test("traversal in a nested output path is rejected", () => {
  const root = workspace({}, ["build"]);
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        builder: "node",
        outputDirectory: "build/../../outside",
      })
    ),
    "INVALID_CONFIG"
  );
});

test("missing nested application root is rejected", () => {
  const root = workspace({}, ["apps"]);
  assert.equal(
    errorCode(() =>
      validateBuildConfigAgainstWorkspace(root, {
        applicationRoot: "apps/missing/web",
        builder: "node",
      })
    ),
    "PATH_NOT_FOUND"
  );
});

test("workspace that is a file is reported as unavailable", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "build-config-parent-"));
  const file = path.join(parent, "workspace");
  writeFileSync(file, "not a repository");

  assert.equal(
    errorCode(() => validateBuildConfigAgainstWorkspace(file, { builder: "node" })),
    "WORKSPACE_UNAVAILABLE"
  );
});

// --- Explicit vs. detected precedence --------------------------------------

const detectedNode: BuildConfig = {
  applicationRoot: ".",
  builder: "node",
  dockerfilePath: null,
  buildCommand: "vite build",
  startCommand: "vite preview",
  outputDirectory: "dist",
};

test("no explicit and no detected config resolves to null", () => {
  assert.equal(resolveEffectiveConfig(null, null), null);
});

test("detected config is effective when no explicit config exists", () => {
  const effective = resolveEffectiveConfig(null, detectedNode);
  assert.ok(effective);
  assert.equal(effective.builder, "node");
  assert.equal(effective.buildCommand, "vite build");
  assert.equal(effective.sources.buildCommand, "detected");
});

test("explicit config is effective on its own", () => {
  const explicit: BuildConfig = {
    applicationRoot: ".",
    builder: "dockerfile",
    dockerfilePath: "Dockerfile",
    buildCommand: null,
    startCommand: null,
    outputDirectory: null,
  };
  const effective = resolveEffectiveConfig(explicit, null);
  assert.ok(effective);
  assert.equal(effective.builder, "dockerfile");
  assert.equal(effective.sources.builder, "explicit");
});

test("explicit values override detected values for the same builder", () => {
  const explicit: BuildConfig = {
    ...detectedNode,
    buildCommand: "npm run build:prod",
    outputDirectory: null,
  };
  const effective = resolveEffectiveConfig(explicit, detectedNode);
  assert.ok(effective);
  assert.equal(effective.buildCommand, "npm run build:prod");
  assert.equal(effective.sources.buildCommand, "explicit");
  // A field the user left unset falls back to detection:
  assert.equal(effective.outputDirectory, "dist");
  assert.equal(effective.sources.outputDirectory, "detected");
});

test("explicit config is never mixed with a different builder's detection", () => {
  const explicit: BuildConfig = {
    applicationRoot: ".",
    builder: "dockerfile",
    dockerfilePath: "Dockerfile",
    buildCommand: null,
    startCommand: null,
    outputDirectory: null,
  };
  const effective = resolveEffectiveConfig(explicit, detectedNode);
  assert.ok(effective);
  assert.equal(effective.builder, "dockerfile");
  assert.equal(effective.buildCommand, null, "node detection must not leak into Dockerfile config");
  assert.equal(effective.startCommand, null);
  assert.equal(effective.sources.buildCommand, "explicit");
});

// --- Detection DTOs ---------------------------------------------------------

test("Vite detection produces detected config and bounded evidence", () => {
  const secret = "SECRET_TOKEN_SHOULD_NOT_LEAK";
  const root = workspace({
    "package.json": JSON.stringify({
      name: "app",
      scripts: { build: "vite build" },
      devDependencies: { vite: "^5.0.0" },
    }),
    "vite.config.ts": `export default { outDir: 'dist' }; // ${secret}`,
  });

  const response = runDetectionInWorkspace(root, "a".repeat(40), null);
  assert.equal(response.status, "detected");
  assert.ok(response.detected);
  assert.equal(response.detected.config.builder, "node");
  assert.equal(response.detected.config.buildCommand, "vite build");
  assert.ok(response.detected.evidence.length > 0);
  assert.ok(response.detected.evidence.every((e) => e.fact.length <= 301));
  assert.ok(!JSON.stringify(response).includes(secret), "no file contents may leak");
  assert.equal(response.explicit, null);
});

test("detection only uses observed commands, never suggestions", () => {
  const root = workspace({
    "package.json": JSON.stringify({ name: "app", devDependencies: { vite: "^5.0.0" } }),
  });

  const response = runDetectionInWorkspace(root, "b".repeat(40), null);
  assert.equal(response.status, "detected");
  assert.ok(response.detected);
  // No scripts.build → detected config must not invent one...
  assert.equal(response.detected.config.buildCommand, null);
  // ...but the suggestion channel is populated.
  assert.ok(response.detected.suggestions.some((s) => s.field === "buildCommand"));
});

test("ambiguous monorepo reports candidates and selects nothing", () => {
  const root = workspace({
    "package.json": JSON.stringify({ name: "root" }),
    "apps/web/package.json": JSON.stringify({ name: "web" }),
    "packages/api/package.json": JSON.stringify({ name: "api" }),
  });

  const response = runDetectionInWorkspace(root, "c".repeat(40), null);
  assert.equal(response.status, "ambiguous");
  assert.equal(response.detected, null);
  assert.ok(response.ambiguous);
  assert.deepEqual(response.ambiguous.candidates, ["apps/web", "packages/api"]);
  assert.equal(response.effective, null);
});

test("conflicting lockfiles are reported as unsupported, not a crash", () => {
  const root = workspace({
    "package.json": JSON.stringify({ name: "app" }),
    "package-lock.json": "{}",
    "yarn.lock": "",
  });

  const response = runDetectionInWorkspace(root, "d".repeat(40), null);
  assert.equal(response.status, "unsupported");
  assert.equal(response.unsupported?.code, "PREFLIGHT_CONFLICTING_LOCKFILES");
  assert.equal(response.detected, null);
});

test("saved explicit config is validated against the checkout without being changed", () => {
  const root = workspace({
    "package.json": JSON.stringify({ name: "app", scripts: { build: "vite build" } }),
  });
  const explicit: BuildConfig = {
    applicationRoot: "missing-app",
    builder: "node",
    dockerfilePath: null,
    buildCommand: "echo custom",
    startCommand: null,
    outputDirectory: null,
  };

  const response = runDetectionInWorkspace(root, "e".repeat(40), explicit);
  assert.deepEqual(response.explicit, explicit, "explicit config must be returned unchanged");
  assert.ok(response.explicitIssues.length > 0);
  assert.match(response.explicitIssues[0], /PATH_NOT_FOUND/);
  // The explicit command still wins for the effective view.
  assert.equal(response.effective?.buildCommand, "echo custom");
});

test("evidence and suggestions are capped in the response", () => {
  const evidence = Array.from({ length: 120 }, (_, i) => ({
    file: `f${i}.json`,
    fact: `fact ${i}`,
    type: "marker" as const,
  }));
  const suggestions = Array.from({ length: 120 }, (_, i) => ({
    field: "buildCommand" as const,
    value: `cmd ${i}`,
    basis: "basis",
    confidence: "medium" as const,
  }));
  const detection: StackDetection = {
    kind: "node",
    hasDockerfile: false,
    packageManager: null,
    detail: "node",
    language: "node",
    framework: "none",
    buildCommand: null,
    startCommand: null,
    outputDirectory: null,
    evidence,
    suggestions,
    confidence: "low",
    needsReview: true,
  };

  const response = detectedResponse(detection, "f".repeat(40), null);
  assert.ok(response.detected);
  assert.equal(response.detected.evidence.length, 50);
  assert.equal(response.detected.suggestions.length, 50);
});

test("ambiguous candidates are capped and text is bounded", () => {
  const candidates = Array.from({ length: 120 }, (_, i) => `${"x".repeat(400)}-${i}`);
  const err = new StackDetectorError("PREFLIGHT_NEEDS_CONFIG", "ambiguous", candidates);
  const response = ambiguousResponse(err, "a".repeat(40), null);
  assert.ok(response.ambiguous);
  assert.equal(response.ambiguous.candidates.length, 50);
  assert.ok(response.ambiguous.candidates.every((c) => c.length <= 301));
  assert.ok(boundText("x".repeat(1000)).length <= 301);
});

test("detected config maps builder kinds explicitly", () => {
  const base: StackDetection = {
    kind: "dockerfile",
    hasDockerfile: true,
    packageManager: null,
    detail: "dockerfile",
    language: "dockerfile",
    framework: "none",
    buildCommand: null,
    startCommand: null,
    outputDirectory: null,
    evidence: [],
    suggestions: [],
    confidence: "high",
    needsReview: false,
  };
  assert.equal(detectionToConfig(base).builder, "dockerfile");
  assert.equal(detectionToConfig(base).dockerfilePath, "Dockerfile");
  assert.equal(detectionToConfig({ ...base, kind: "rust" }).builder, "rust");
  assert.equal(detectionToConfig({ ...base, kind: "static" }).dockerfilePath, null);
});

// --- Controller responses ---------------------------------------------------

interface FakeResponse {
  res: Response;
  status: () => number;
  body: () => unknown;
}

function fakeResponse(): FakeResponse {
  let statusCode = 200;
  let payload: unknown = undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    },
  };
  return {
    res: res as unknown as Response,
    status: () => statusCode,
    body: () => payload,
  };
}

function fakeRequest(id: string, body?: unknown): Request {
  return { params: { id }, body } as unknown as Request;
}

test("GET config returns null when nothing is saved", async () => {
  const controllers = createBuildConfigControllers({
    getConfig: async () => null,
  });
  const out = fakeResponse();
  await controllers.getBuildConfigController(fakeRequest(VALID_ID), out.res);
  assert.equal(out.status(), 200);
  assert.deepEqual(out.body(), { config: null, updatedAt: null });
});

test("GET config returns the saved configuration", async () => {
  const stored = {
    config: {
      applicationRoot: ".",
      builder: "node" as const,
      dockerfilePath: null,
      buildCommand: "npm run build",
      startCommand: "npm start",
      outputDirectory: "dist",
    },
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const controllers = createBuildConfigControllers({ getConfig: async () => stored });
  const out = fakeResponse();
  await controllers.getBuildConfigController(fakeRequest(VALID_ID), out.res);
  assert.equal(out.status(), 200);
  assert.deepEqual(out.body(), { config: stored.config, updatedAt: stored.updatedAt });
});

test("PUT config returns the persisted configuration", async () => {
  const config = {
    applicationRoot: ".",
    builder: "dockerfile" as const,
    dockerfilePath: "Dockerfile",
    buildCommand: null,
    startCommand: null,
    outputDirectory: null,
  };
  const controllers = createBuildConfigControllers({
    saveConfig: async (_id, input) => ({
      config: parseBuildConfig(input),
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  });
  const out = fakeResponse();
  await controllers.putBuildConfigController(fakeRequest(VALID_ID, config), out.res);
  assert.equal(out.status(), 200);
  assert.deepEqual((out.body() as { config: unknown }).config, config);
});

test("PUT invalid configuration returns 400", async () => {
  const controllers = createBuildConfigControllers({
    saveConfig: async (_id, input) => {
      parseBuildConfig(input);
      throw new Error("unreachable");
    },
  });
  const out = fakeResponse();
  await controllers.putBuildConfigController(
    fakeRequest(VALID_ID, { builder: "node", applicationRoot: "../escape" }),
    out.res
  );
  assert.equal(out.status(), 400);
  assert.match(String((out.body() as { error: string }).error), /applicationRoot/);
});

test("invalid project id returns 400 without calling services", async () => {
  let called = false;
  const controllers = createBuildConfigControllers({
    getConfig: async () => {
      called = true;
      return null;
    },
  });
  const out = fakeResponse();
  await controllers.getBuildConfigController(fakeRequest("not-a-uuid"), out.res);
  assert.equal(out.status(), 400);
  assert.equal(called, false);
});

test("DELETE config returns null configuration", async () => {
  const controllers = createBuildConfigControllers({
    clearConfig: async () => undefined,
  });
  const out = fakeResponse();
  await controllers.deleteBuildConfigController(fakeRequest(VALID_ID), out.res);
  assert.equal(out.status(), 200);
  assert.deepEqual(out.body(), { config: null });
});

test("detect returns a detection response", async () => {
  const detection: DetectionResponse = {
    status: "detected",
    commitSha: "a".repeat(40),
    detected: null,
    ambiguous: null,
    unsupported: null,
    explicit: null,
    effective: null,
    explicitIssues: [],
  };
  const controllers = createBuildConfigControllers({
    detectProject: async () => detection,
  });
  const out = fakeResponse();
  await controllers.detectProjectController(fakeRequest(VALID_ID), out.res);
  assert.equal(out.status(), 200);
  assert.deepEqual(out.body(), detection);
});

test("checkout failures map to bounded HTTP errors", async () => {
  const controllers = createBuildConfigControllers({
    detectProject: async () => {
      throw new SourceCheckoutError("INVALID_REPOSITORY_URL", "details that should not leak");
    },
  });
  const out = fakeResponse();
  await controllers.detectProjectController(fakeRequest(VALID_ID), out.res);
  assert.equal(out.status(), 422);
  assert.deepEqual(out.body(), {
    error: "Repository could not be checked out",
    code: "INVALID_REPOSITORY_URL",
  });
});

test("git checkout failures map to 502", async () => {
  const controllers = createBuildConfigControllers({
    detectProject: async () => {
      throw new SourceCheckoutError("GIT_COMMAND_FAILED", "fatal: details");
    },
  });
  const out = fakeResponse();
  await controllers.detectProjectController(fakeRequest(VALID_ID), out.res);
  assert.equal(out.status(), 502);
});
