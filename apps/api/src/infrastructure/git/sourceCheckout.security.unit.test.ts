import test from "node:test";
import assert from "node:assert/strict";

import {
  SourceCheckoutError,
  validateRepositoryUrl,
} from "./sourceCheckout.js";

test("rejects query strings and fragments", () => {
  for (const url of [
    "https://github.com/acme/app?x=1",
    "https://github.com/acme/app#main",
  ]) {
    assert.throws(
      () => validateRepositoryUrl(url),
      (error: unknown) =>
        error instanceof SourceCheckoutError &&
        error.code === "INVALID_REPOSITORY_URL"
    );
  }
});

test("rejects non-default ports", () => {
  assert.throws(
    () => validateRepositoryUrl("https://github.com:8443/acme/app.git"),
    (error: unknown) =>
      error instanceof SourceCheckoutError &&
      error.code === "UNSUPPORTED_REPOSITORY_PORT"
  );
});

test("rejects owner-only paths", () => {
  assert.throws(
    () => validateRepositoryUrl("https://github.com/acme"),
    (error: unknown) =>
      error instanceof SourceCheckoutError &&
      error.code === "INVALID_REPOSITORY_URL"
  );
});
