import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DB_GATED_SUITES,
  gateDb,
  gatedSuitesForScope,
  isRequireDb,
  missingExecutedSuites,
} from "./dbGate.js";

const SRC_ROOT = path.join(__dirname, "..");

function discoverDbSuites(): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "test") walk(path.join(dir, entry.name), rel);
      } else if (entry.name.endsWith(".db.unit.test.ts")) {
        found.push(rel);
      }
    }
  };
  walk(SRC_ROOT, "");
  found.push("agents/agentAuthentication.unit.test.ts");
  found.push("agents/edgeAgentClient.integration.test.ts");
  return found.sort();
}

test("gate registry covers every database-dependent suite", () => {
  assert.deepEqual([...DB_GATED_SUITES].sort(), discoverDbSuites());
});

test("scope filtering splits the registry into what each run actually discovers", () => {
  // A unit-only glob never discovers *.integration.test.ts, so the unit scope
  // must exclude it; otherwise the verifier can never pass on a unit run.
  const unit = gatedSuitesForScope("unit");
  const integration = gatedSuitesForScope("integration");
  const all = gatedSuitesForScope("all");

  assert.ok(unit.length > 0, "unit scope must not be empty");
  assert.ok(integration.length > 0, "integration scope must not be empty");
  assert.equal(unit.length + integration.length, all.length);
  assert.deepEqual([...all].sort(), [...DB_GATED_SUITES].sort());

  for (const suite of unit) assert.ok(suite.endsWith(".unit.test.ts"), suite);
  for (const suite of integration) assert.ok(suite.endsWith(".integration.test.ts"), suite);
  for (const suite of all) assert.ok(suite.endsWith(".unit.test.ts") || suite.endsWith(".integration.test.ts"), suite);
  // No overlap: each suite is verified by exactly one scope.
  for (const suite of unit) assert.ok(!integration.includes(suite), suite);
});

test("verifier refuses to pass an empty or unconfigured gate", () => {
  const env = (over: Record<string, string | undefined>) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.DB_GATE_DIR;
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete childEnv[k];
      else childEnv[k] = v;
    }
    return childEnv;
  };
  const check = (over: Record<string, string | undefined>) =>
    spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/test/dbGateCheck.ts", "unit"], {
      cwd: path.join(SRC_ROOT, ".."),
      env: env(over),
      encoding: "utf8",
      timeout: 60_000,
    });

  // 1. No marker directory configured at all.
  const unset = check({});
  assert.equal(unset.status, 2);
  assert.ok(`${unset.stdout}${unset.stderr}`.includes("DB_GATE_DIR must be set"));

  // 2. Marker directory configured but never created by a test run.
  const absent = check({ DB_GATE_DIR: path.join(mkdtempSync(path.join(os.tmpdir(), "dk-gate-")), "nope") });
  assert.equal(absent.status, 2);
  assert.ok(`${absent.stdout}${absent.stderr}`.includes("does not exist"));
});

test("gate markers distinguish executed, skipped, and missing suites", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploykit-dbgate-"));
  try {
    assert.deepEqual(missingExecutedSuites(dir, ["a.test.ts", "b.test.ts"]), [
      "a.test.ts",
      "b.test.ts",
    ]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "a.test.ts.json"),
      JSON.stringify({ suite: "a.test.ts", executed: true })
    );
    writeFileSync(
      path.join(dir, "b.test.ts.json"),
      JSON.stringify({ suite: "b.test.ts", executed: false })
    );
    assert.deepEqual(missingExecutedSuites(dir, ["a.test.ts", "b.test.ts"]), ["b.test.ts"]);
    writeFileSync(path.join(dir, "b.test.ts.json"), "not-json{{");
    assert.deepEqual(missingExecutedSuites(dir, ["a.test.ts", "b.test.ts"]), ["b.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gateDb records markers and honors REQUIRE_DB", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploykit-dbgate-"));
  const previousGateDir = process.env.DB_GATE_DIR;
  const previousRequire = process.env.REQUIRE_DB;
  try {
    process.env.DB_GATE_DIR = dir;
    delete process.env.REQUIRE_DB;
    assert.equal(isRequireDb(), false);
    assert.equal(await gateDb("s/skipped.test.ts", async () => false), false);
    assert.equal(await gateDb("s/ran.test.ts", async () => true), true);
    assert.deepEqual(missingExecutedSuites(dir, ["s/skipped.test.ts", "s/ran.test.ts"]), [
      "s/skipped.test.ts",
    ]);
    process.env.REQUIRE_DB = "1";
    assert.equal(isRequireDb(), true);
    await assert.rejects(
      gateDb("s/missing.test.ts", async () => false),
      /REQUIRE_DB=1 but the database is unavailable/
    );
    await assert.rejects(
      gateDb("s/broken.test.ts", async () => {
        throw new Error("connection refused");
      }),
      /REQUIRE_DB=1 but the database is unavailable/
    );
    assert.equal(await gateDb("s/ok.test.ts", async () => true), true);
  } finally {
    if (previousGateDir === undefined) delete process.env.DB_GATE_DIR;
    else process.env.DB_GATE_DIR = previousGateDir;
    if (previousRequire === undefined) delete process.env.REQUIRE_DB;
    else process.env.REQUIRE_DB = previousRequire;
    rmSync(dir, { recursive: true, force: true });
  }
});

function runSuiteOnce(
  env: Record<string, string | undefined>,
  suite = "src/services/deploymentConcurrency.db.unit.test.ts"
): { status: number | null; output: string } {
  const { REQUIRE_DB: _require, DB_GATE_DIR: _gate, ...rest } = process.env;
  const childEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (key === "NODE_TEST_CONTEXT" || key === "NODE_TEST_WORKER_ID") continue;
    childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/tsx/dist/cli.mjs",
      "--test",
      "--test-concurrency=1",
      suite,
    ],
    {
      cwd: path.join(SRC_ROOT, ".."),
      env: childEnv as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 180_000,
    }
  );
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

// Points at a closed local port so the suites take their "database unavailable"
// path without ever printing or requiring real credentials.
const NO_DB_URL = "postgresql://deploykit:deploykit@127.0.0.1:54991/deploykit";

test("missing database fails the suite under REQUIRE_DB=1", () => {
  const { status, output } = runSuiteOnce({ DATABASE_URL: NO_DB_URL, REQUIRE_DB: "1" });
  assert.notEqual(status, 0);
  assert.ok(output.includes("REQUIRE_DB=1 but the database is unavailable"));
});

test("missing database skips the suite without REQUIRE_DB", () => {
  const env: Record<string, string> = {
    DATABASE_URL: NO_DB_URL,
  };
  const { status, output } = runSuiteOnce(env);
  assert.equal(status, 0);
  assert.ok(!output.includes("REQUIRE_DB=1 but the database is unavailable"));
});

// Regression: these two suites register a test.after() cleanup hook. The hook
// must not issue pool queries when the gate skipped every test body, otherwise
// teardown throws against an unreachable database and fails the whole file.
for (const suite of [
  "src/services/security.db.unit.test.ts",
  "src/services/registrationRace.db.unit.test.ts",
]) {
  test(`${suite} teardown does not query the database when the gate skips`, () => {
    const { status, output } = runSuiteOnce({ DATABASE_URL: NO_DB_URL }, suite);
    assert.equal(status, 0, `expected ${suite} to pass without a database:\n${output}`);
    assert.ok(
      !output.includes("role") || !output.includes("does not exist"),
      `teardown must not raise a database connection error:\n${output}`
    );
  });
}
