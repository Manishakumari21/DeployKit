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

export function normalizeDomain(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  let value = raw.trim().toLowerCase();
  if (!value) {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  if (value.endsWith(".")) {
    value = value.slice(0, -1);
  }
  if (!value || value.length > 253) {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }

  if (/[\x00-\x20\x7f\s]/.test(value)) {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  if (value.includes("*")) {
    throw new DomainError("INVALID_HOSTNAME", "Wildcard domains are not supported");
  }
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
  if (IPV4_PATTERN.test(ascii) || ascii.includes(":")) {
    throw new DomainError("INVALID_HOSTNAME", "IP addresses are not valid domains");
  }
  const labels = ascii.split(".");
  if (labels.length < 2) {
    throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
  }
  for (const label of labels) {
    if (!label || label.length > 63 || !LABEL_PATTERN.test(label)) {
      throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
    }
    if (label.startsWith("xn--") && label.length < 6) {
      throw new DomainError("INVALID_HOSTNAME", "Invalid hostname");
    }
  }
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
