ALTER TABLE custom_domains
ADD COLUMN IF NOT EXISTS tls_requested_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS tls_last_attempt_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS tls_last_error_code VARCHAR(100),
ADD COLUMN IF NOT EXISTS tls_last_error TEXT;

CREATE INDEX IF NOT EXISTS custom_domains_tls_pending_idx
ON custom_domains (tls_status)
WHERE tls_status IN ('pending', 'renewing');
