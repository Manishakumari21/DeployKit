import test from "node:test";
import assert from "node:assert/strict";

import {
  runIncidentSweep,
  sanitizeEvidence,
  type IncidentCandidate,
} from "./incidentService.js";

test("evidence strings are redacted and bounded", () => {
  const long = `token: ghp_${"A".repeat(800)}`;
  const out = sanitizeEvidence({ error: long, ok: 42, flag: true, empty: null });
  const error = String(out.error);
  assert.ok(error.length <= 500, "evidence strings are capped");
  assert.ok(!error.includes("ghp_AAAA"), "secrets are redacted");
  assert.equal(out.ok, 42);
  assert.equal(out.flag, true);
  assert.ok(!("empty" in out), "null entries are dropped");
});

test("evidence keeps only the first bounded number of entries", () => {
  const input: Record<string, unknown> = {};
  for (let i = 0; i < 40; i += 1) input[`k${i}`] = `v${i}`;
  const out = sanitizeEvidence(input);
  assert.equal(Object.keys(out).length, 16, "entry count is bounded");
});

test("evidence never passes unknown shapes through raw", () => {
  const out = sanitizeEvidence({
    nested: { secret: "value" },
    list: [1, 2, 3],
    when: new Date("2026-10-25T00:00:00.000Z"),
  });
  assert.equal(out.nested, "[object]", "objects are replaced by a marker");
  assert.equal(out.list, "[object]", "arrays are replaced by a marker");
  assert.ok(out.when instanceof Date, "dates pass through");
});

test("bearer credentials are redacted inside evidence", () => {
  const out = sanitizeEvidence({ line: "Authorization: Bearer abc.def-123 denied" });
  assert.ok(!String(out.line).includes("abc.def-123"));
  assert.ok(String(out.line).includes("[redacted]"));
});

test("one failing detector never stops the remaining detectors", async () => {
  let secondRan = false;
  const summary = await runIncidentSweep([
    {
      name: "exploding",
      run: async (): Promise<IncidentCandidate[]> => {
        throw new Error("detector exploded");
      },
    },
    {
      name: "healthy",
      run: async (): Promise<IncidentCandidate[]> => {
        secondRan = true;
        return [];
      },
    },
  ]);

  assert.ok(secondRan, "the later detector still ran");
  assert.ok(
    summary.errors.some((entry) => entry.startsWith("exploding:")),
    "the failure is reported, not swallowed"
  );
  assert.ok(
    !summary.errors.some((entry) => entry.startsWith("healthy:")),
    "the healthy detector is not marked failed"
  );
});

test("sweep returns a summary and never throws when detectors fail", async () => {
  const summary = await runIncidentSweep([
    {
      name: "always_throws",
      run: async (): Promise<IncidentCandidate[]> => {
        throw new Error("boom");
      },
    },
  ]);
  assert.equal(summary.created, 0);
  assert.equal(typeof summary.resolved, "number");
  assert.ok(summary.errors.length >= 1);
});

test("empty detector list produces a clean zero summary", async () => {
  const summary = await runIncidentSweep([]);
  assert.deepEqual(
    { created: summary.created, updated: summary.updated, touched: summary.touched, skipped: summary.skipped, resolved: summary.resolved },
    { created: 0, updated: 0, touched: 0, skipped: 0, resolved: 0 }
  );
});
