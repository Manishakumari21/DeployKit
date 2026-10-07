CREATE TABLE IF NOT EXISTS custom_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL
        REFERENCES projects(id) ON DELETE CASCADE,
    domain TEXT NOT NULL
        CHECK (
            char_length(domain) BETWEEN 1 AND 253
            AND domain !~ '\s'
        ),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verifying', 'verified', 'failed', 'removed')),
    verification_token_hash TEXT NOT NULL
        CHECK (char_length(verification_token_hash) = 64),
    verified_at TIMESTAMP WITH TIME ZONE,
    verification_expires_at TIMESTAMP WITH TIME ZONE,
    tls_status TEXT NOT NULL DEFAULT 'none'
        CHECK (tls_status IN ('none', 'pending', 'issued', 'renewing', 'failed', 'expired')),
    cert_expires_at TIMESTAMP WITH TIME ZONE,
    cert_path TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_domains_domain_unique
ON custom_domains (lower(domain));

CREATE INDEX IF NOT EXISTS custom_domains_project_status_idx
ON custom_domains (project_id, status);

CREATE INDEX IF NOT EXISTS custom_domains_tls_expiry_idx
ON custom_domains (tls_status, cert_expires_at)
WHERE tls_status <> 'none';

DROP TRIGGER IF EXISTS custom_domains_set_updated_at ON custom_domains;

CREATE TRIGGER custom_domains_set_updated_at
BEFORE UPDATE ON custom_domains
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
