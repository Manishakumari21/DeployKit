import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectStack, StackDetectorError } from "./stackDetector.js";

function workspace(files: Record<string, string> = {}, dirs: string[] = []): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploykit-stack-"));
  for (const d of dirs) mkdirSync(path.join(dir, d), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StackDetectorError);
    return error.code;
  }
  assert.fail("expected a StackDetectorError");
}

test("Dockerfile application passes", () => {
  const dir = workspace({ Dockerfile: "FROM node:22\n", "package.json": '{"name":"app"}' });
  try {
    const result = detectStack(dir);
    assert.equal(result.kind, "dockerfile");
    assert.equal(result.hasDockerfile, true);
  } finally {
    cleanup(dir);
  }
});

test("Dockerfile wins over conflicting lockfiles", () => {
  const dir = workspace({
    Dockerfile: "FROM node:22\n",
    "package.json": "{}",
    "package-lock.json": "{}",
    "yarn.lock": "",
  });
  try {
    assert.equal(detectStack(dir).kind, "dockerfile");
  } finally {
    cleanup(dir);
  }
});

test("Node.js with npm lockfile is classified without guessing commands", () => {
  const dir = workspace({ "package.json": '{"name":"app"}', "package-lock.json": "{}" });
  try {
    const result = detectStack(dir);
    assert.equal(result.kind, "node");
    assert.equal(result.packageManager, "npm");
    assert.equal(result.hasDockerfile, false);
  } finally {
    cleanup(dir);
  }
});

test("Node.js package managers are distinguished", () => {
  const cases: Array<[string, string]> = [
    ["yarn.lock", "yarn"],
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lockb", "bun"],
  ];
  for (const [lock, manager] of cases) {
    const dir = workspace({ "package.json": "{}", [lock]: "" });
    try {
      const result = detectStack(dir);
      assert.equal(result.kind, "node");
      assert.equal(result.packageManager, manager);
    } finally {
      cleanup(dir);
    }
  }
});

test("conflicting lockfiles are rejected", () => {
  const dir = workspace({ "package.json": "{}", "package-lock.json": "{}", "yarn.lock": "" });
  try {
    assert.equal(codeOf(() => detectStack(dir)), "PREFLIGHT_CONFLICTING_LOCKFILES");
  } finally {
    cleanup(dir);
  }
});

test("Python applications are classified", () => {
  for (const marker of ["pyproject.toml", "requirements.txt"]) {
    const dir = workspace({ [marker]: "# deps" });
    try {
      assert.equal(detectStack(dir).kind, "python");
    } finally {
      cleanup(dir);
    }
  }
});

test("static site with only index.html is classified", () => {
  const dir = workspace({ "index.html": "<html></html>" });
  try {
    assert.equal(detectStack(dir).kind, "static");
  } finally {
    cleanup(dir);
  }
});

test("empty repository is rejected", () => {
  const dir = workspace();
  try {
    assert.equal(codeOf(() => detectStack(dir)), "PREFLIGHT_MISSING_INPUTS");
  } finally {
    cleanup(dir);
  }
});

test("monorepo markers require explicit configuration", () => {
  for (const marker of ["pnpm-workspace.yaml", "turbo.json"]) {
    const dir = workspace({ [marker]: "", "package.json": "{}" });
    try {
      assert.equal(codeOf(() => detectStack(dir)), "PREFLIGHT_NEEDS_CONFIG");
    } finally {
      cleanup(dir);
    }
  }
});

test("nested package.json alongside a root one is ambiguous", () => {
  const dir = workspace({ "package.json": "{}", "apps/web/package.json": "{}" });
  try {
    assert.equal(codeOf(() => detectStack(dir)), "PREFLIGHT_NEEDS_CONFIG");
  } finally {
    cleanup(dir);
  }
});

test("symlinked Dockerfile is unsafe", () => {
  const dir = workspace({ "real-Dockerfile": "FROM node:22\n" });
  symlinkSync(path.join(dir, "real-Dockerfile"), path.join(dir, "Dockerfile"));
  try {
    assert.equal(codeOf(() => detectStack(dir)), "PREFLIGHT_UNSAFE_PATH");
  } finally {
    cleanup(dir);
  }
});

test("symlinked inputs are treated as absent, not followed", () => {
  const dir = workspace({ "real-package.json": "{}" });
  symlinkSync(path.join(dir, "real-package.json"), path.join(dir, "package.json"));
  try {
    assert.equal(codeOf(() => detectStack(dir)), "PREFLIGHT_MISSING_INPUTS");
  } finally {
    cleanup(dir);
  }
});

test("unreadable workspace fails the check without executing anything", () => {
  assert.equal(
    codeOf(() => detectStack(path.join(os.tmpdir(), "deploykit-stack-no-such-dir-xyz"))),
    "PREFLIGHT_CHECK_FAILED"
  );
});
