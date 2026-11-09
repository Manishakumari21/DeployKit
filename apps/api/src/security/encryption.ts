/**
 * DeployKit Project Environment Variables Encryption Module
 *
 * Cryptographic Architecture:
 * - Cipher: AES-256-GCM authenticated symmetric encryption.
 * - IV: 12-byte (96-bit) cryptographically secure random nonce per encryption.
 * - Authentication Tag: 16-byte (128-bit) GCM authentication tag.
 * - Key Derivation: RFC 5869 HKDF-SHA256 derived from DEPLOYKIT_TOKEN_PEPPER.
 *   - Salt: "deploykit:env:salt:v1"
 *   - Info / Context: "deploykit:env:encryption:aes-256-gcm:v1"
 *   - Key Length: 32 bytes (256 bits)
 *
 * Consequences of Changing DEPLOYKIT_TOKEN_PEPPER:
 * - DEPLOYKIT_TOKEN_PEPPER is the root key derivation material.
 * - If DEPLOYKIT_TOKEN_PEPPER changes without re-encrypting existing secrets,
 *   all previously stored environment variables will fail GCM authentication
 *   (throwing EncryptionError with code "DECRYPTION_FAILED").
 * - In addition, existing sessions and edge agent tokens derived from the pepper
 *   will be invalidated.
 *
 * Safe Rotation Strategy:
 * 1. Maintain a transition window with OLD_PEPPER and NEW_PEPPER.
 * 2. Execute an automated re-encryption migration:
 *    a. SELECT id, value_encrypted FROM project_env_vars.
 *    b. Decrypt each ciphertext using OLD_PEPPER.
 *    c. Re-encrypt each plaintext using NEW_PEPPER.
 *    d. UPDATE project_env_vars SET value_encrypted = new_ciphertext atomically.
 * 3. Update DEPLOYKIT_TOKEN_PEPPER environment variable across all replicas to NEW_PEPPER.
 */

import crypto from "node:crypto";
import { getTokenPepperValue } from "./tokenHasher.js";

export class EncryptionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EncryptionError";
    this.code = code;
  }
}

export const HKDF_SALT = "deploykit:env:salt:v1";
export const HKDF_INFO = "deploykit:env:encryption:aes-256-gcm:v1";

const HEX_IV_REGEX = /^[0-9a-f]{24}$/i;
const HEX_TAG_REGEX = /^[0-9a-f]{32}$/i;
const HEX_DATA_REGEX = /^([0-9a-f]{2})*$/i;

export function deriveEncryptionKey(pepper?: string): Buffer {
  const secret = pepper !== undefined ? pepper : getTokenPepperValue();
  const derived = crypto.hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    32
  );
  return Buffer.from(derived);
}

export function encryptSecret(plaintext: string): string {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(payload: string): string {
  if (typeof payload !== "string" || !payload.startsWith("v1:")) {
    throw new EncryptionError("INVALID_CIPHERTEXT", "Unrecognized ciphertext format");
  }
  const parts = payload.split(":");
  if (parts.length !== 4) {
    throw new EncryptionError("INVALID_CIPHERTEXT", "Malformed ciphertext payload");
  }
  const [, ivHex, tagHex, dataHex] = parts;
  if (!ivHex || !tagHex || dataHex === undefined) {
    throw new EncryptionError("INVALID_CIPHERTEXT", "Missing ciphertext components");
  }

  if (!HEX_IV_REGEX.test(ivHex) || !HEX_TAG_REGEX.test(tagHex) || !HEX_DATA_REGEX.test(dataHex)) {
    throw new EncryptionError("INVALID_CIPHERTEXT", "Ciphertext components must be valid hexadecimal");
  }

  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");

  if (iv.length !== 12 || tag.length !== 16) {
    throw new EncryptionError("INVALID_CIPHERTEXT", "Invalid IV or auth tag length");
  }

  const key = deriveEncryptionKey();
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    throw new EncryptionError("DECRYPTION_FAILED", "Failed to decrypt secret payload: authentication failed");
  }
}
