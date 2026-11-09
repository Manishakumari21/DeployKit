import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  deriveEncryptionKey,
  EncryptionError,
  HKDF_SALT,
  HKDF_INFO,
} from "./encryption.js";
import { resetTokenPepperCache, TOKEN_PEPPER_ENV } from "./tokenHasher.js";

test("deriveEncryptionKey: HKDF-SHA256 properties and domain separation", () => {
  const key1 = deriveEncryptionKey("test-pepper-1");
  const key2 = deriveEncryptionKey("test-pepper-2");
  assert.equal(key1.length, 32);
  assert.equal(key2.length, 32);
  assert.notDeepEqual(key1, key2);

  // Verify HKDF output matches manual RFC 5869 derivation
  const manual = crypto.hkdfSync(
    "sha256",
    Buffer.from("test-pepper-1", "utf8"),
    Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    32
  );
  assert.deepEqual(key1, Buffer.from(manual));
});

test("encryptSecret and decryptSecret round-trip arbitrary text", () => {
  const secret = "postgres://user:super_secret_password@db.local:5432/app?sslmode=require";
  const encrypted = encryptSecret(secret);
  assert.ok(encrypted.startsWith("v1:"));
  assert.notEqual(encrypted, secret);
  const decrypted = decryptSecret(encrypted);
  assert.equal(decrypted, secret);
});

test("encryptSecret handles empty string and unicode secrets", () => {
  for (const val of ["", "🔑🔒🚀 unicode-secret-値-12345", "a".repeat(10_000)]) {
    const enc = encryptSecret(val);
    assert.equal(decryptSecret(enc), val);
  }
});

test("encryptSecret generates unique ciphertexts (unique IV) for identical input", () => {
  const secret = "identical-secret-value";
  const enc1 = encryptSecret(secret);
  const enc2 = encryptSecret(secret);
  assert.notEqual(enc1, enc2);
  assert.equal(decryptSecret(enc1), secret);
  assert.equal(decryptSecret(enc2), secret);
});

test("decryptSecret rejects tampered ciphertext fail-closed", () => {
  const encrypted = encryptSecret("my-secret");
  const [v, ivHex, tagHex, dataHex] = encrypted.split(":");

  // 1. Tamper ciphertext data
  const tamperedData = dataHex.slice(0, -2) + (dataHex.endsWith("aa") ? "bb" : "aa");
  assert.throws(
    () => decryptSecret(`${v}:${ivHex}:${tagHex}:${tamperedData}`),
    (err: unknown) => err instanceof EncryptionError && err.code === "DECRYPTION_FAILED"
  );

  // 2. Tamper auth tag
  const tamperedTag = tagHex.slice(0, -2) + (tagHex.endsWith("aa") ? "bb" : "aa");
  assert.throws(
    () => decryptSecret(`${v}:${ivHex}:${tamperedTag}:${dataHex}`),
    (err: unknown) => err instanceof EncryptionError && err.code === "DECRYPTION_FAILED"
  );

  // 3. Tamper IV
  const tamperedIv = ivHex.slice(0, -2) + (ivHex.endsWith("aa") ? "bb" : "aa");
  assert.throws(
    () => decryptSecret(`${v}:${tamperedIv}:${tagHex}:${dataHex}`),
    (err: unknown) => err instanceof EncryptionError && err.code === "DECRYPTION_FAILED"
  );
});

test("decryptSecret rejects malformed ciphertext fail-closed", () => {
  const malformedCases = [
    "",
    "not-encrypted",
    "v2:012345678901234567890123:01234567890123456789012345678901:abcd", // wrong version
    "v1:only:three:parts",
    "v1:too:many:colon:parts:extra",
    "v1:zzzzzzzzzzzzzzzzzzzzzzzz:01234567890123456789012345678901:abcd", // non-hex IV
    "v1:012345678901234567890123:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz:abcd", // non-hex tag
    "v1:012345678901234567890123:01234567890123456789012345678901:nothex!", // non-hex data
    "v1:012345678901:01234567890123456789012345678901:abcd", // IV too short (6 bytes)
    "v1:012345678901234567890123:0123456789012345:abcd", // tag too short (8 bytes)
  ];

  for (const tc of malformedCases) {
    assert.throws(
      () => decryptSecret(tc),
      (err: unknown) => err instanceof EncryptionError && err.code === "INVALID_CIPHERTEXT",
      `Expected INVALID_CIPHERTEXT for: "${tc}"`
    );
  }
});

test("decryptSecret fails authentication when decrypted with a different pepper", () => {
  const originalPepper = process.env[TOKEN_PEPPER_ENV];
  try {
    process.env[TOKEN_PEPPER_ENV] = "pepper-version-alpha";
    resetTokenPepperCache();
    const encrypted = encryptSecret("top-secret-payload");

    // Switch pepper to simulate changed pepper without re-encryption
    process.env[TOKEN_PEPPER_ENV] = "pepper-version-beta";
    resetTokenPepperCache();

    assert.throws(
      () => decryptSecret(encrypted),
      (err: unknown) => err instanceof EncryptionError && err.code === "DECRYPTION_FAILED"
    );
  } finally {
    if (originalPepper === undefined) {
      delete process.env[TOKEN_PEPPER_ENV];
    } else {
      process.env[TOKEN_PEPPER_ENV] = originalPepper;
    }
    resetTokenPepperCache();
  }
});

test("production refuses key derivation without explicit pepper", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalPepper = process.env[TOKEN_PEPPER_ENV];
  try {
    process.env.NODE_ENV = "production";
    delete process.env[TOKEN_PEPPER_ENV];
    resetTokenPepperCache();

    assert.throws(
      () => deriveEncryptionKey(),
      /DEPLOYKIT_TOKEN_PEPPER must be set explicitly in production/
    );
  } finally {
    process.env.NODE_ENV = originalEnv;
    if (originalPepper === undefined) {
      delete process.env[TOKEN_PEPPER_ENV];
    } else {
      process.env[TOKEN_PEPPER_ENV] = originalPepper;
    }
    resetTokenPepperCache();
  }
});
