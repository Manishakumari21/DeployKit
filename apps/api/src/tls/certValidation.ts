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

export function certificateCoversDomain(pem: string, domain: string): boolean {
  const parsed = parseCertificate(pem);
  const wanted = domain.trim().toLowerCase();
  return parsed.dnsNames.some((name) => !name.includes("*") && name === wanted);
}

export function certificateExpiry(pem: string): Date {
  return parseCertificate(pem).expiresAt;
}

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
