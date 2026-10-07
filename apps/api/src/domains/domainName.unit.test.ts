// Phase 11: domain normalization unit tests (no DB required).
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDomain, challengeRecordName, DomainError } from "./domainName.js";

test("lowercases, trims, and strips one trailing dot", () => {
  assert.equal(normalizeDomain("  Example.COM  "), "example.com");
  assert.equal(normalizeDomain("Example.COM."), "example.com");
  assert.equal(normalizeDomain("WWW.Example.COM"), "www.example.com");
});

test("converts IDN to ASCII via stdlib", () => {
  const ascii = normalizeDomain("münchen.de");
  assert.ok(!ascii.includes("ü"));
  assert.ok(ascii.endsWith(".de"));
  assert.equal(normalizeDomain("münchen.de"), ascii);
});

test("rejects invalid labels, IPs, wildcards, and lengths", () => {
  for (const bad of [
    "",
    "   ",
    "nodot",
    "bad..dots.com",
    "-lead.com",
    "trail-.com",
    "has space.com",
    "has*star.com",
    "*.example.com",
    "192.168.1.1",
    "10.0.0.1",
    "::1",
    "2001:db8::1",
    "localhost",
    "foo.localhost",
    "foo.local",
    "foo.internal",
    "foo.invalid",
    "foo.deploykit.local",
    `${"a".repeat(64)}.com`,
    `${"a".repeat(250)}.com`,
    "foo_bar.com",
    ".",
    ".com",
  ]) {
    assert.throws(() => normalizeDomain(bad), (e: unknown) => e instanceof DomainError);
  }
});

test("challenge record name is derived from the normalized domain", () => {
  assert.equal(
    challengeRecordName("example.com"),
    "_deploykit-challenge.example.com"
  );
});
