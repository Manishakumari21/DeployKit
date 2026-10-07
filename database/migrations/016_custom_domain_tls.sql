-- Phase 11.6: TLS bookkeeping for custom domains (metadata only).
-- Forward-only. Adds columns to custom_domains; touches no existing rows'
-- semantics. Private keys, account keys, and certificate PEM material are
-- NEVER stored here — only status, timestamps, paths, and safe errors.

ALTER TABLE custom_domains
ADD COLUMN IF NOT EXISTS tls_requested_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS tls_last_attempt_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS tls_last_error_code VARCHAR(100),
ADD COLUMN IF NOT EXISTS tls_last_error TEXT;

-- Claim scan: worker finds domains awaiting issuance/renewal without
-- scanning unrelated rows. Expiry-driven renewal keeps using
-- custom_domains_tls_expiry_idx from migration 015.
CREATE INDEX IF NOT EXISTS custom_domains_tls_pending_idx
ON custom_domains (tls_status)
WHERE tls_status IN ('pending', 'renewing');
