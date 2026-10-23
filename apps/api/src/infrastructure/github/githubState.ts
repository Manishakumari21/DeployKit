import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getWebhookSecret } from "./githubConfig.js";

const STATE_TTL_MS = 10 * 60 * 1000;

export class GitHubStateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GitHubStateError";
    this.code = code;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signature(payload: string): string {
  return base64url(createHmac("sha256", getWebhookSecret()).update(payload).digest());
}

export function createGitHubState(userId: string, now = Date.now()): string {
  if (!userId) throw new GitHubStateError("INVALID_STATE_SUBJECT", "Missing state subject");
  const payload = base64url(
    JSON.stringify({
      sub: userId,
      exp: now + STATE_TTL_MS,
      nonce: randomBytes(16).toString("hex"),
    })
  );
  return `${payload}.${signature(payload)}`;
}

export function verifyGitHubState(state: string, now = Date.now()): { userId: string } {
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GitHubStateError("INVALID_STATE", "Invalid GitHub state");
  }
  const expected = signature(parts[0]);
  const actualBuffer = Buffer.from(parts[1]);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new GitHubStateError("INVALID_STATE", "Invalid GitHub state");
  }
  let payload: { sub?: unknown; exp?: unknown; nonce?: unknown };
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new GitHubStateError("INVALID_STATE", "Invalid GitHub state");
  }
  if (
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    typeof payload.nonce !== "string" ||
    payload.nonce.length < 16
  ) {
    throw new GitHubStateError("INVALID_STATE", "Invalid GitHub state");
  }
  if (payload.exp <= now) {
    throw new GitHubStateError("STATE_EXPIRED", "GitHub connection expired");
  }
  return { userId: payload.sub };
}
