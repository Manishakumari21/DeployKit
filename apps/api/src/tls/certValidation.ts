// Phase 11.8: certificate validation using only Node standard library.
// No custom crypto: parsing and SAN matching rely on node:crypto
// X509Certificate. Only safe metadata (domain, expiry, fingerprint) ever
// leaves these functions — PEM bytes are never logged or returned in errors.

import { X509Certificate } from "node:crypto";

export class CertValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CertValidationError";
    this.code = code;
  }
}

export interface ParsedCertificate {
  expiresAt: Date;
  issuedAt: Date;
  dnsNames: string[];
  fingerprint256: string;
}

export function parseCertificate(pem: string): ParsedCertificate {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw new CertValidationError("INVALID_CERTIFICATE", "Certificate is not parseable");
  }
  return {
    expiresAt: new Date(cert.validTo),
    issuedAt: new Date(cert.validFrom),
    dnsNames: (cert.subjectAltName ?? "")
      .split(", ")
      .filter((entry) => entry.startsWith("DNS:"))
      .map((entry) => entry.slice(4).toLowerCase()),
    fingerprint256: cert.fingerprint256,
  };
}

// Exact SAN match only. Wildcard SANs are rejected: Phase 11 issues one
// certificate per verified domain and never broadens SANs silently.
export function certificateCoversDomain(pem: string, domain: string): boolean {
  const parsed = parseCertificate(pem);
  const wanted = domain.trim().toLowerCase();
  return parsed.dnsNames.some((name) => !name.includes("*") && name === wanted);
}

export function certificateExpiry(pem: string): Date {
  return parseCertificate(pem).expiresAt;
}

// Validity rule shared by the renderer gate and issuance: the certificate
// must parse, cover the domain exactly, and be currently unexpired.
export function validateCertificateForDomain(
  pem: string,
  domain: string,
  now: Date = new Date()
): ParsedCertificate {
  const parsed = parseCertificate(pem);
  if (!certificateCoversDomain(pem, domain)) {
    throw new CertValidationError(
      "CERT_HOSTNAME_MISMATCH",
      `Certificate does not cover ${domain}`
    );
  }
  if (Number.isNaN(parsed.expiresAt.getTime())) {
    throw new CertValidationError("INVALID_CERTIFICATE", "Certificate has no usable expiry");
  }
  if (parsed.expiresAt <= now) {
    throw new CertValidationError("CERTIFICATE_EXPIRED", "Certificate is expired");
  }
  return parsed;
}
