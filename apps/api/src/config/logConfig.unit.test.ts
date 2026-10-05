import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_LOG_CONFIG, getLogConfig } from "./logConfig.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("log config defaults match documented values", () => {
  withEnv(
    {
      DEPLOYKIT_LOG_RETENTION_DAYS: undefined,
      DEPLOYKIT_LOG_MAX_LINES_PER_DEPLOYMENT: undefined,
      DEPLOYKIT_LOG_MAX_BYTES_PER_DEPLOYMENT: undefined,
      DEPLOYKIT_LOG_MAX_MESSAGE_BYTES: undefined,
    },
    () => {
      assert.deepEqual(getLogConfig(), DEFAULT_LOG_CONFIG);
    }
  );
});

test("log config rejects zero, negative, and absurd values", () => {
  for (const name of [
    "DEPLOYKIT_LOG_RETENTION_DAYS",
    "DEPLOYKIT_LOG_MAX_LINES_PER_DEPLOYMENT",
    "DEPLOYKIT_LOG_MAX_BYTES_PER_DEPLOYMENT",
    "DEPLOYKIT_LOG_MAX_MESSAGE_BYTES",
  ]) {
    for (const bad of ["0", "-5", "not-a-number", "999999999999"]) {
      withEnv({ [name]: bad }, () => {
        assert.throws(() => getLogConfig(), new RegExp(name));
      });
    }
  }
});
