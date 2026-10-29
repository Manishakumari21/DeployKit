import crypto from "node:crypto";

export const TOKEN_PEPPER_ENV = "DEPLOYKIT_TOKEN_PEPPER";

export type TokenPepperSource = "env" | "ephemeral";

let cached: { value: string; source: TokenPepperSource } | null = null;

function resolvePepper(): { value: string; source: TokenPepperSource } {
  if (cached !== null) {
    return cached;
  }
  const configured = (process.env[TOKEN_PEPPER_ENV] ?? "").trim();
  if (configured.length > 0) {
    cached = { value: configured, source: "env" };
    return cached;
  }
  if (process.env.NODE_ENV === "production") {
    // Fail closed: an ephemeral pepper would silently invalidate every stored
    // session and agent token on restart and differ across replicas, so
    // production must not boot without a stable secret.
    throw new Error(
      `${TOKEN_PEPPER_ENV} must be set explicitly in production`
    );
  }
  cached = {
    value: crypto.randomBytes(32).toString("hex"),
    source: "ephemeral",
  };
  console.warn(
    `${TOKEN_PEPPER_ENV} is not set: using an ephemeral per-process pepper. ` +
      `Stored token hashes can no longer be replayed from a database dump, but ` +
      `sessions and agent tokens do not survive an API restart. Set ` +
      `${TOKEN_PEPPER_ENV} to a stable secret before running multiple API ` +
      `replicas or in production.`
  );
  return cached;
}

export function tokenPepperSource(): TokenPepperSource {
  return resolvePepper().source;
}

export function hashSecret(secret: string): string {
  return crypto
    .createHmac("sha256", resolvePepper().value)
    .update(secret, "utf8")
    .digest("hex");
}

export function resetTokenPepperCache(): void {
  cached = null;
}
