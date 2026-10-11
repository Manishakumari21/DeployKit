import { existsSync } from "node:fs";
import type { GateScope } from "./dbGate.js";
import {
  DB_GATED_SUITES,
  gateDir,
  gatedSuitesForScope,
  missingExecutedSuites,
} from "./dbGate.js";

function parseScope(argv: string[]): GateScope {
  const raw = argv[0] ?? "unit";
  if (raw !== "unit" && raw !== "integration" && raw !== "all") {
    console.error(
      `db-gate: unknown scope "${raw}" (expected unit, integration, or all)`
    );
    process.exit(2);
  }
  return raw;
}

const scope = parseScope(process.argv.slice(2));
const dir = gateDir();
if (dir === null) {
  console.error("DB_GATE_DIR must be set to the marker directory used by the test run");
  process.exit(2);
}

const expected = gatedSuitesForScope(scope);

// Never report success when nothing was actually gated for this scope, so an
// empty registry or a wrong scope cannot make the gate pass vacuously.
if (expected.length === 0) {
  console.error(
    `db-gate: no database suites are registered for scope "${scope}"; ` +
      `refusing to pass an empty gate`
  );
  process.exit(2);
}
if (!existsSync(dir)) {
  console.error(
    `db-gate: marker directory ${dir} does not exist; ` +
      `the test run never recorded any database suite`
  );
  process.exit(2);
}

const missing = missingExecutedSuites(dir, expected);
if (missing.length > 0) {
  console.error(
    `db-gate: ${missing.length} database suite(s) did not execute:\n` +
      missing.map((suite) => `  - ${suite}`).join("\n")
  );
  process.exit(1);
}
console.log(
  `db-gate: all ${expected.length} database suites executed ` +
    `(scope ${scope}, registry ${DB_GATED_SUITES.length})`
);