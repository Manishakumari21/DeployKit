

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import pool from "../db/database.js";
import app from "../app.js";
import { gateDb } from "../test/dbGate.js";
import { ipBucket, resetRateLimitKey } from "./rateLimitService.js";

const TEST_CLIENT_IP = "198.51.100.55";

let server: ReturnType<typeof app.listen> | null = null;
let base = "";

let dbEstablished = false;

test.after(async () => {
  if (dbEstablished) {
    await pool.query(`DELETE FROM users WHERE email LIKE 'phase10-race-%'`);
    await resetRateLimitKey(ipBucket(TEST_CLIENT_IP));
  }
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((e: unknown) => (e ? reject(e) : resolve()))
    );
    server = null;
  }
});

test("concurrent first registrations admit exactly one account", async (t) => {
  const dbAvailable = await gateDb("services/registrationRace.db.unit.test.ts", async () => {
    try {
      await pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  });
  if (!dbAvailable) return;
  dbEstablished = true;
  await resetRateLimitKey(ipBucket(TEST_CLIENT_IP));
  const usersBefore = (await pool.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n;
  if (usersBefore !== 0) {
    t.skip("users table is not empty; cannot test the empty-table bootstrap window");
    return;
  }
  delete process.env.DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION;
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const stamp = Date.now();
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": TEST_CLIENT_IP,
        },
        body: JSON.stringify({
          email: `phase10-race-${stamp}-${i}@example.com`,
          password: "correct-horse-123",
        }),
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }))
    )
  );
  const created = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 403);
  assert.equal(created.length, 1);
  assert.equal(rejected.length, 5);
  for (const r of rejected) {
    assert.deepEqual(r.body, { error: "Public registration is disabled" });
  }
  const count = (
    await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE email LIKE 'phase10-race-%'`)
  ).rows[0].n;
  assert.equal(count, 1);
});
