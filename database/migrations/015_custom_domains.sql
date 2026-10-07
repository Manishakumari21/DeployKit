-- Phase 11.1: custom domain foundation (verification only, no TLS issuance).
-- Forward-only. Does not modify any existing table and touches no existing rows.
-- PostgreSQL is the source of truth; gateway files are a derived projection.
-- Private TLS keys are NEVER stored here (only path/expiry metadata later).

CREATE TABLE IF NOT EXISTS custom_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL
        REFERENCES projects(id) ON DELETE CASCADE,
    -- Stored normalized (trimmed, lowercased, ASCII/punycode, no trailing dot)
    -- by domainService.normalizeDomain. DB checks are a backstop only.
    domain TEXT NOT NULL
        CHECK (
            char_length(domain) BETWEEN 1 AND 253
            AND domain !~ '\s'
        ),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verifying', 'verified', 'failed', 'removed')),
    -- SHA-256 hex digest (64 chars) of the DNS TXT verification token.
    -- The raw token is returned once to the owner on creation; only the
    -- digest is persisted so a DB read never yields a usable token.
    verification_token_hash TEXT NOT NULL
        CHECK (char_length(verification_token_hash) = 64),
    verified_at TIMESTAMP WITH TIME ZONE,
    -- Verification must be completed before this timestamp; expiry forces
    -- re-verification with a rotated token. NULL means no expiry (legacy).
    verification_expires_at TIMESTAMP WITH TIME ZONE,
    -- TLS lifecycle stays independent: this phase never issues certs.
    -- 'none' is the only writer in Phase 11; later phases move pending→issued.
    tls_status TEXT NOT NULL DEFAULT 'none'
        CHECK (tls_status IN ('none', 'pending', 'issued', 'renewing', 'failed', 'expired')),
    cert_expires_at TIMESTAMP WITH TIME ZONE,
    -- Filesystem path reference only (e.g. /etc/nginx/certs/<domain>/fullchain.pem).
    -- Never key material. NULL until TLS is implemented.
    cert_path TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Global hijack prevention: one domain belongs to at most one project,
-- case-insensitively, independent of application normalization.
CREATE UNIQUE INDEX IF NOT EXISTS custom_domains_domain_unique
ON custom_domains (lower(domain));

-- Project-scoped listing for the renderer: one query fetches verified domains.
CREATE INDEX IF NOT EXISTS custom_domains_project_status_idx
ON custom_domains (project_id, status);

-- Renewal sweeper path for later TLS phases (indexed aggregate, no scans).
CREATE INDEX IF NOT EXISTS custom_domains_tls_expiry_idx
ON custom_domains (tls_status, cert_expires_at)
WHERE tls_status <> 'none';

DROP TRIGGER IF EXISTS custom_domains_set_updated_at ON custom_domains;

CREATE TRIGGER custom_domains_set_updated_at
BEFORE UPDATE ON custom_domains
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
