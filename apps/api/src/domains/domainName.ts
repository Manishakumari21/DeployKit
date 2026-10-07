// Phase 11.1: single shared custom-domain normalization path.
// Controllers, services, and the gateway renderer must all use
// normalizeDomain() — never duplicate parsing.
// Uses only Node standard library (node:url domainToASCII); no new deps.

import { domainToASCII } from "node:url";

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
  }
}

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

// WHY: custom domains become nginx server_name values. Strict allowlisting
// here is the only place user input enters gateway config; the renderer
// trusts this output verbatim (after re-validation).
export function normalizeDomain(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  let value = raw.trim().toLowerCase();
  if (!value) {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  // Remove one trailing dot (FQDN form). A bare "." becomes empty → reject.
  if (value.endsWith(".")) {
    value = value.slice(0, -1);
  }
  if (!value || value.length > 253) {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  // Reject control characters / whitespace early (also enforced by DB CHECK).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f\s]/.test(value)) {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  // Phase 11 does not support wildcards.
  if (value.includes("*")) {
    throw new DomainError("INVALID_HOSTNAME", "Wildcard domains are not supported");
  }
  // Unicode → ASCII (punycode) via stdlib. Empty result = malformed IDN.
  let ascii: string;
  try {
    ascii = domainToASCII(value);
  } catch {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  if (!ascii) {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  ascii = ascii.toLowerCase();
  if (ascii.length > 253) {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  // Reject IP literals (v4 dotted + v6 colon forms). Domains must be names.
  if (IPV4_PATTERN.test(ascii) || ascii.includes(":")) {
    throw new DomainError("INVALID_HOSTNAME", "IP addresses are not valid domains");
  }
  const labels = ascii.split(".");
  // Require at least one dot (no single-label hostnames).
  if (labels.length < 2) {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  for (const label of labels) {
    if (!label || label.length > 63 || !LABEL_PATTERN.test(label)) {
      throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
    }
    // Reject malformed punycode (xn-- without valid encoding).
    if (label.startsWith("xn--") && label.length < 6) {
      throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
    }
  }
  // Reject localhost / internal-only names. The .deploykit.local namespace
  // is reserved for derived project hostnames (see routeServerName).
  if (
    ascii === "localhost" ||
    ascii.endsWith(".localhost") ||
    ascii === "local" ||
    ascii.endsWith(".local") ||
    ascii.endsWith(".internal") ||
    ascii.endsWith(".invalid") ||
    ascii.endsWith(".example") ||
    ascii.endsWith(".test") ||
    ascii.endsWith(".deploykit.local")
  ) {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  return ascii;
}

export function challengeRecordName(domain: string): string {
  return `_deploykit-challenge.${domain}`;
}
