

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Mode = "enforce" | "no-db" | "require-db";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE_ROOT = path.join(API_ROOT, ".db-gate");
const TSX_CLI = path.join("node_modules", "tsx", "dist", "cli.mjs");
const UNIT_GLOB = "src/**/*.unit.test.ts";

function parseMode(argv: string[]): Mode {
  const flag = argv.find((a) => a.startsWith("--mode="));
  const value = flag?.slice("--mode=".length) ?? "enforce";
  if (value === "enforce" || value === "no-db" || value === "require-db") return value;
  console.error(`run-unit-tests: unknown mode "${value}"`);
  process.exit(2);
}

const mode = parseMode(process.argv.slice(2));

mkdirSync(GATE_ROOT, { recursive: true });
const GATE_DIR = mkdtempSync(path.join(GATE_ROOT, "run-"));

const childEnv: NodeJS.ProcessEnv = { ...process.env, DB_GATE_DIR: GATE_DIR };
if (mode === "require-db") childEnv.REQUIRE_DB = "1";
else delete childEnv.REQUIRE_DB;

const tests = spawnSync(
  process.execPath,
  [TSX_CLI, "--test", "--test-concurrency=1", UNIT_GLOB],
  { cwd: API_ROOT, env: childEnv, stdio: "inherit" }
);
if (tests.error) {
  console.error(`run-unit-tests: failed to start the test runner: ${tests.error.message}`);
  process.exit(2);
}

const testsOk = tests.status === 0;

function runGate(scope: string): number {
  const gate = spawnSync(
    process.execPath,
    [TSX_CLI, "src/test/dbGateCheck.ts", scope],
    { cwd: API_ROOT, env: childEnv, stdio: "inherit" }
  );
  if (gate.error) {
    console.error(`run-unit-tests: failed to run the gate verifier: ${gate.error.message}`);
    return 2;
  }
  return gate.status ?? 2;
}

let exitCode = testsOk ? 0 : (tests.status ?? 1);

if (mode === "no-db") {


  const gate = spawnSync(
    process.execPath,
    [TSX_CLI, "src/test/dbGateCheck.ts", "unit"],
    { cwd: API_ROOT, env: childEnv, stdio: "pipe", encoding: "utf8" }
  );
  const output = `${gate.stdout ?? ""}${gate.stderr ?? ""}`;
  const notRun = output.match(/^ {2}- .+$/gm) ?? [];
  if (gate.status === 0) {
    console.log("db-gate: every database suite executed; database tests passed.");
  } else {
    console.log(
      `\ndb-gate (--mode=no-db): ${notRun.length} database suite(s) DID NOT RUN ` +
        `because PostgreSQL was unavailable.\n` +
        `These results do NOT cover database behavior:\n` +
        (notRun.length > 0 ? notRun.map((l) => `${l}\n`).join("") : `  ${output.trim()}\n`) +
        `Run "npm run test:db-required" with a reachable DATABASE_URL for full coverage.`
    );
  }
} else if (testsOk) {

  const gateExit = runGate("unit");
  if (gateExit !== 0 && exitCode === 0) exitCode = gateExit;
}

if (existsSync(GATE_DIR)) {
  if (exitCode === 0) {
    rmSync(GATE_DIR, { recursive: true, force: true });
  } else {
    console.log(`\ndb-gate: markers for this run left in ${GATE_DIR}`);
  }
}

if (existsSync(GATE_ROOT) && readdirSync(GATE_ROOT).length === 0) {
  rmSync(GATE_ROOT, { recursive: true, force: true });
}
process.exit(exitCode);