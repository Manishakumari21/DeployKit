import test from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "./dockerExec.js";

test("runCommand resolves normal execution with aborted=false", async () => {
  const result = await runCommand("node", ["-e", "process.stdout.write('hi')"], 5_000);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "hi");
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test("runCommand reports wall-clock timeout and kills the child", async () => {
  const start = Date.now();
  const result = await runCommand("node", ["-e", "setTimeout(()=>{}, 30_000)"], 300);
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.ok(Date.now() - start < 10_000);
});

test("runCommand aborts via AbortSignal and reports aborted", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const start = Date.now();
  const result = await runCommand("node", ["-e", "setTimeout(()=>{}, 30_000)"], 15_000, undefined, controller.signal);
  assert.equal(result.aborted, true);
  assert.ok(Date.now() - start < 10_000);
});

test("runCommand with already-aborted signal never spawns", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCommand("node", ["-e", "process.exit(0)"], 5_000, undefined, controller.signal);
  assert.equal(result.aborted, true);
});
