// Phase 10 Step 4: session/cookie configuration. Fail-fast like logConfig:
// invalid values throw at startup rather than silently weakening security.

export const SESSION_COOKIE_NAME = "deploykit_session";

const DAY_MS = 24 * 60 * 60 * 1000;

export function getSessionLifetimeMs(): number {
  const raw = process.env.DEPLOYKIT_SESSION_DAYS;
  if (raw === undefined || raw === "") return 7 * DAY_MS;
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new Error("DEPLOYKIT_SESSION_DAYS must be an integer between 1 and 365");
  }
  return days * DAY_MS;
}

// Explicit opt-in for open registration. Unset means closed; the first user
// can still self-register while the users table is empty (bootstrap window),
// which closes automatically once anyone exists.
export function isPublicRegistrationEnabled(): boolean {
  const raw = process.env.DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION;
  if (raw === undefined || raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error('DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION must be "true" or "false"');
}

// Secure cookies only where HTTPS is expected. Explicit override wins;
// otherwise production defaults to Secure and local dev stays plain HTTP.
export function isCookieSecure(): boolean {
  const raw = process.env.DEPLOYKIT_COOKIE_SECURE;
  if (raw === undefined || raw === "") {
    return process.env.NODE_ENV === "production";
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error('DEPLOYKIT_COOKIE_SECURE must be "true" or "false"');
}
