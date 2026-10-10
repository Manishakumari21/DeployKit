import test from "node:test";
import assert from "node:assert/strict";
import { isManagedOrphanContainer, cleanupOrphanedContainers } from "./orphanCleanup.js";

test("only DeployKit-scoped runtime names are treated as orphans", () => {
  assert.equal(isManagedOrphanContainer("dk-p12345678-dabcdef12"), true);
  assert.equal(isManagedOrphanContainer("dk-p11111111-d22222222"), true);
  assert.equal(isManagedOrphanContainer("deploykit-worker"), false);
  assert.equal(isManagedOrphanContainer("dk-gateway"), false);
  assert.equal(isManagedOrphanContainer("postgres"), false);
  assert.equal(isManagedOrphanContainer("../evil"), false);
  assert.equal(isManagedOrphanContainer("dk-pZZZZZZZZ-d12345678"), false);
  assert.equal(isManagedOrphanContainer(""), false);
});

test("orphan cleanup with unreachable binary is a safe no-op", async () => {
  const removed = await cleanupOrphanedContainers("definitely-not-a-docker-binary-xyz", 2_000);
  assert.equal(removed, 0);
});

test("orphan cleanup never runs global destructive commands", async () => {

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const src = await readFile(join(process.cwd(), "src/workers/orphanCleanup.ts"), "utf8");
  assert.ok(!src.includes("system prune"));
  assert.ok(!src.includes("rmi "));
  assert.ok(src.includes("io.deploykit.managed=true"));
  assert.ok(src.includes("isManagedOrphanContainer"));
});
