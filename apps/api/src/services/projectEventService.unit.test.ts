import test from "node:test";
import assert from "node:assert/strict";
import pool from "../db/database.js";
import { getProjectEvents } from "./projectEventService.js";

test("lists project events with a bounded limit", async () => {
  const original = pool.query;
  let sql = "";
  let values: unknown[] = [];
  pool.query = (async (text: string, params?: unknown[]) => {
    sql = text;
    values = params ?? [];
    return {
      rows: [
        {
          id: "7",
          deployment_id: "22222222-2222-4222-8222-222222222222",
          event_type: "deployment.active",
          status_from: "verifying",
          status_to: "active",
          message: "Deployment active",
          metadata: {},
          created_at: "2026-10-23T00:00:00.000Z",
          branch: "main",
          commit_sha: "abcdef1234567890",
          trigger: "manual",
        },
      ],
      rowCount: 1,
    };
  }) as typeof pool.query;
  try {
    const rows = await getProjectEvents(
      "11111111-1111-4111-8111-111111111111",
      500
    );
    assert.deepEqual(values, ["11111111-1111-4111-8111-111111111111", 100]);
    assert.match(sql, /WHERE d\.project_id = \$1/);
    assert.match(sql, /ORDER BY e\.created_at DESC, e\.id DESC/);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status_to, "active");
  } finally {
    pool.query = original;
  }
});
