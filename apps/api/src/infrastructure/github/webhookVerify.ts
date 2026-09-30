import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

export class WebhookVerifyError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = "WebhookVerifyError";
    this.code = code;
    this.status = status;
  }
}

export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): void {
  if (signatureHeader === undefined) {
    throw new WebhookVerifyError("MISSING_SIGNATURE", "Missing webhook signature", 401);
  }
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!match) {
    throw new WebhookVerifyError("MALFORMED_SIGNATURE", "Malformed webhook signature", 401);
  }
  if (!secret) {
    throw new WebhookVerifyError("MISSING_SECRET", "Webhook secret not configured", 500);
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(match[1], "hex");
  } catch {
    throw new WebhookVerifyError("MALFORMED_SIGNATURE", "Malformed webhook signature", 401);
  }
  if (actual.length !== expected.length) {
    throw new WebhookVerifyError("INVALID_SIGNATURE", "Invalid webhook signature", 401);
  }
  if (!timingSafeEqual(actual, expected)) {
    throw new WebhookVerifyError("INVALID_SIGNATURE", "Invalid webhook signature", 401);
  }
}
