import test from "node:test";
import assert from "node:assert/strict";
import pool from "./database.js";

test("pool has an error listener so idle-connection failures cannot crash the process", () => {
  assert.ok(
    pool.listenerCount("error") > 0,
    "expected an 'error' listener on the shared pool"
  );
});

test("pool error listener logs a redacted message and never throws", () => {
  const lines: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args);
  };
  try {
    const secret = "postgres://deploykit:s3cret@db.internal:5432/deploykit";
    for (const listener of pool.listeners("error")) {
      (listener as (error: unknown) => void)(
        new Error(`terminating connection ${secret}`)
      );
    }
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, pool.listenerCount("error"));
  const logged = JSON.stringify(lines);
  assert.ok(!logged.includes("s3cret"), "pool error must not leak connection secrets");
  assert.ok(logged.includes("Database pool error"));
});
