import test from "node:test";
import assert from "node:assert/strict";

import { buildCorsOptions } from "./corsConfig.js";

test("CORS advertises the build-config PUT method", () => {
  const previous = process.env.DEPLOYKIT_WEB_ORIGIN;
  process.env.DEPLOYKIT_WEB_ORIGIN = "http://localhost:8083";
  try {
    const options = buildCorsOptions();
    assert.ok(options.methods.includes("GET"));
    assert.ok(options.methods.includes("POST"));
    assert.ok(options.methods.includes("PUT"));
    assert.ok(options.methods.includes("DELETE"));
    assert.ok(options.methods.includes("OPTIONS"));
  } finally {
    if (previous === undefined) {
      delete process.env.DEPLOYKIT_WEB_ORIGIN;
    } else {
      process.env.DEPLOYKIT_WEB_ORIGIN = previous;
    }
  }
});
