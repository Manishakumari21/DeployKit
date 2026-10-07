// Phase 11.8: ACME issuance via the maintained lego binary (no custom
// ACME/crypto code). One certificate per verified domain over HTTP-01.
//
// Lego contract (stable CLI across v4/v5): account + certificate state lives
// under --path; HTTP-01 webroot mode writes challenge files to
// <webroot>/.well-known/acme-challenge/<token>, which the gateway serves on
// port 80. Unit tests pin the exact argv so flag drift is caught in review.
//
//   lego --email E --domains D --server S --path P --accept-tos \
//       --http --http.webroot W run
//   lego --email E --domains D --server S --path P --accept-tos \
//       --http --http.webroot W renew --days N
//
// Secrets discipline: email/domain/server are not secrets and travel as argv;
// account keys and certificate keys never appear in argv, env, logs, or the
// database — lego keeps them under --path inside the certs volume.

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../infrastructure/process/dockerExec.js";
import { normalizeDomain } from "../domains/domainName.js";
import { certificateExpiry } from "./certValidation.js";
import { acmeWorkDir, challengeWebroot } from "./certPaths.js";

export const ACME_STAGING_URL = "https://acme-staging-v02.api.letsencrypt.org/directory";
export const ACME_PRODUCTION_URL = "https://acme-v02.api.letsencrypt.org/directory";
export const LEGO_TIMEOUT_MS = 180_000;

export class AcmeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AcmeError";
    this.code = code;
  }
}

export interface AcmeResult {
  certificatePem: string;
  privateKeyPem: string;
  issuerPem: string | null;
  expiresAt: Date;
}

export interface AcmeRequest {
  domain: string;
  email: string;
  serverUrl: string;
  legoPath: string;
  webroot: string;
  renew: boolean;
  renewDays: number;
}

export interface AcmeClient {
  requestCertificate(domain: string, renew?: boolean): Promise<AcmeResult>;
}

export interface AcmeConfig {
  binary: string;
  email: string;
  serverUrl: string;
  legoPath: string;
  webroot: string;
  timeoutMs: number;
}

// Staging is the fail-safe default: production issuance requires explicitly
// setting DEPLOYKIT_ACME_SERVER to the production directory URL.
export function getAcmeConfig(overrides: Partial<AcmeConfig> = {}): AcmeConfig {
  const email = (process.env.DEPLOYKIT_ACME_EMAIL ?? "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AcmeError("ACME_CONFIG_MISSING", "DEPLOYKIT_ACME_EMAIL must be a valid email for certificate issuance");
  }
  return {
    binary: (process.env.DEPLOYKIT_LEGO_BINARY ?? "lego").trim() || "lego",
    email,
    serverUrl: (process.env.DEPLOYKIT_ACME_SERVER ?? ACME_STAGING_URL).trim() || ACME_STAGING_URL,
    legoPath: acmeWorkDir(),
    webroot: challengeWebroot(),
    timeoutMs: LEGO_TIMEOUT_MS,
    ...overrides,
  };
}

// Pure argv builder (unit-tested): the only place lego flags are spelled.
export function legoArgsFor(request: AcmeRequest): string[] {
  const domain = normalizeDomain(request.domain);
  const base = [
    "--email", request.email,
    "--domains", domain,
    "--server", request.serverUrl,
    "--path", request.legoPath,
    "--accept-tos",
    "--http",
    "--http.webroot", request.webroot,
  ];
  if (request.renew) {
    return [...base, "renew", "--days", String(request.renewDays)];
  }
  return [...base, "run"];
}

function legoCertFile(legoPath: string, domain: string, suffix: string): string {
  return path.join(legoPath, "certificates", `${normalizeDomain(domain)}${suffix}`);
}

export class LegoAcmeClient implements AcmeClient {
  constructor(private readonly config: AcmeConfig) {}

  async requestCertificate(domain: string, renew = false): Promise<AcmeResult> {
    const normalized = normalizeDomain(domain);
    await mkdir(this.config.webroot, { recursive: true });
    await mkdir(this.config.legoPath, { recursive: true });
    const args = legoArgsFor({
      domain: normalized,
      email: this.config.email,
      serverUrl: this.config.serverUrl,
      legoPath: this.config.legoPath,
      webroot: this.config.webroot,
      renew,
      renewDays: 45,
    });
    let result;
    try {
      result = await runCommand(this.config.binary, args, this.config.timeoutMs);
    } catch (error) {
      throw new AcmeError(
        "ACME_REQUEST_FAILED",
        error instanceof Error ? `ACME client failed: ${error.message.slice(0, 300)}` : "ACME client failed"
      );
    }
    if (result.aborted) {
      throw new AcmeError("ACME_REQUEST_FAILED", "ACME request was aborted");
    }
    if (result.timedOut) {
      throw new AcmeError("ACME_REQUEST_FAILED", "ACME request timed out");
    }
    if (result.code !== 0) {
      // Lego echoes the failing challenge/authorization on stderr. It never
      // contains key material, but bound it anyway and never log the domain's
      // private key (which this client never prints).
      const detail = (result.stderr || `exit ${result.code}`).slice(0, 500);
      throw new AcmeError("ACME_REQUEST_FAILED", `Certificate order failed: ${detail}`);
    }
    // Read back exactly the files lego wrote for this domain — never any
    // other domain's material, never via shell expansion.
    let certificatePem: string;
    let privateKeyPem: string;
    try {
      certificatePem = await readFile(legoCertFile(this.config.legoPath, normalized, ".crt"), "utf8");
      privateKeyPem = await readFile(legoCertFile(this.config.legoPath, normalized, ".key"), "utf8");
    } catch {
      throw new AcmeError("ACME_REQUEST_FAILED", "ACME client did not produce certificate files");
    }
    let issuerPem: string | null = null;
    try {
      issuerPem = await readFile(legoCertFile(this.config.legoPath, normalized, ".issuer.crt"), "utf8");
    } catch {
      issuerPem = null;
    }
    if (!certificatePem.includes("BEGIN CERTIFICATE") || !privateKeyPem.includes("PRIVATE KEY")) {
      throw new AcmeError("ACME_REQUEST_FAILED", "ACME client produced invalid certificate material");
    }
    return { certificatePem, privateKeyPem, issuerPem, expiresAt: certificateExpiry(certificatePem) };
  }
}

// Local development/testing only: openssl-generated self-signed certificate
// with a proper SAN. Refuses production outright. Never represents an ACME
// issuance: callers must keep tls provenance separate (docs + issuedCTV).
export class SelfSignedAcmeClient implements AcmeClient {
  constructor(
    private readonly opensslBinary = "openssl",
    private readonly daysValid = 90
  ) {
    if (process.env.NODE_ENV === "production") {
      throw new AcmeError("TLS_MODE_FORBIDDEN", "Self-signed certificates are forbidden in production");
    }
  }

  async requestCertificate(domain: string): Promise<AcmeResult> {
    const normalized = normalizeDomain(domain);
    const { mkdtemp, readFile: read, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const work = await mkdtemp(path.join(tmpdir(), "deploykit-selfsigned-"));
    try {
      const keyPath = path.join(work, "key.pem");
      const crtPath = path.join(work, "cert.pem");
      const gen = await runCommand(
        this.opensslBinary,
        [
          "req", "-x509", "-newkey", "rsa:2048",
          "-keyout", keyPath,
          "-out", crtPath,
          "-days", String(this.daysValid),
          "-nodes",
          "-subj", `/CN=${normalized}`,
          "-addext", `subjectAltName=DNS:${normalized}`,
        ],
        60_000
      );
      if (gen.code !== 0) {
        throw new AcmeError("ACME_REQUEST_FAILED", "Self-signed generation failed");
      }
      const [privateKeyPem, certificatePem] = await Promise.all([
        read(keyPath, "utf8"),
        read(crtPath, "utf8"),
      ]);
      return { certificatePem, privateKeyPem, issuerPem: null, expiresAt: certificateExpiry(certificatePem) };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// Deterministic in-memory client for unit tests. Never touches the network,
// the filesystem, or real crypto.
export class FakeAcmeClient implements AcmeClient {
  public requests: Array<{ domain: string }> = [];
  constructor(
    private readonly handler?: (domain: string) => AcmeResult | Error
  ) {}

  async requestCertificate(domain: string): Promise<AcmeResult> {
    const normalized = normalizeDomain(domain);
    this.requests.push({ domain: normalized });
    if (this.handler) {
      const out = this.handler(normalized);
      if (out instanceof Error) throw out;
      return out;
    }
    throw new AcmeError("ACME_REQUEST_FAILED", "FakeAcmeClient has no handler");
  }
}
