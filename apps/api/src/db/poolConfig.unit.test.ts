import test from "node:test";
import assert from "node:assert/strict";
import { parsePoolConfig, POOL_DEFAULTS, POOL_LIMITS } from "./poolConfig.js";

test("parsePoolConfig uses sensible production defaults when env is unset", () => {
  const config = parsePoolConfig({});
  assert.equal(config.max, POOL_DEFAULTS.max);
  assert.equal(config.min, POOL_DEFAULTS.min);
  assert.equal(config.connectionTimeoutMillis, POOL_DEFAULTS.connectionTimeoutMillis);
  assert.equal(config.idleTimeoutMillis, POOL_DEFAULTS.idleTimeoutMillis);
  assert.equal(config.maxLifetimeSeconds, POOL_DEFAULTS.maxLifetimeSeconds);
});

test("parsePoolConfig respects valid custom environment variables", () => {
  const config = parsePoolConfig({
    DATABASE_POOL_MAX: "25",
    DATABASE_POOL_MIN: "5",
    DATABASE_POOL_CONNECTION_TIMEOUT_MS: "3000",
    DATABASE_POOL_IDLE_TIMEOUT_MS: "15000",
    DATABASE_POOL_MAX_LIFETIME_MS: "900",
  });
  assert.equal(config.max, 25);
  assert.equal(config.min, 5);
  assert.equal(config.connectionTimeoutMillis, 3000);
  assert.equal(config.idleTimeoutMillis, 15000);
  assert.equal(config.maxLifetimeSeconds, 900);
});

test("parsePoolConfig falls back to defaults on invalid non-numeric values", () => {
  const config = parsePoolConfig({
    DATABASE_POOL_MAX: "not-a-number",
    DATABASE_POOL_MIN: "xyz",
    DATABASE_POOL_CONNECTION_TIMEOUT_MS: "",
    DATABASE_POOL_IDLE_TIMEOUT_MS: "-100",
  });
  assert.equal(config.max, POOL_DEFAULTS.max);
  assert.equal(config.min, POOL_DEFAULTS.min);
  assert.equal(config.connectionTimeoutMillis, POOL_DEFAULTS.connectionTimeoutMillis);
  assert.equal(config.idleTimeoutMillis, POOL_DEFAULTS.idleTimeoutMillis);
});

test("parsePoolConfig clamps values exceeding safe boundaries", () => {
  const config = parsePoolConfig({
    DATABASE_POOL_MAX: "5000", // exceeds maxMax (100)
    DATABASE_POOL_MIN: "200",  // exceeds max (clamped to max)
    DATABASE_POOL_CONNECTION_TIMEOUT_MS: "100", // below connectionTimeoutMinMs (500)
    DATABASE_POOL_IDLE_TIMEOUT_MS: "9999999", // exceeds idleTimeoutMaxMs (600000)
  });
  assert.equal(config.max, POOL_LIMITS.maxMax);
  assert.equal(config.min, POOL_LIMITS.maxMax);
  assert.equal(config.connectionTimeoutMillis, POOL_LIMITS.connectionTimeoutMinMs);
  assert.equal(config.idleTimeoutMillis, POOL_LIMITS.idleTimeoutMaxMs);
});

test("parsePoolConfig enforces min <= max even if custom min is valid but larger than max", () => {
  const config = parsePoolConfig({
    DATABASE_POOL_MAX: "10",
    DATABASE_POOL_MIN: "15",
  });
  assert.equal(config.max, 10);
  assert.equal(config.min, 10);
});
