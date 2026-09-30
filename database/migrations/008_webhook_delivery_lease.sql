-- Phase 04 audit: delivery claim lease for crash recovery.
-- Forward-only; no destructive changes. Reuses set_updated_at() from 002.

ALTER TABLE github_webhook_deliveries
ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE github_webhook_deliveries
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill lease clock from existing timestamps.
UPDATE github_webhook_deliveries
SET updated_at = COALESCE(processed_at, created_at)
WHERE updated_at IS NULL OR updated_at >= CURRENT_TIMESTAMP - INTERVAL '1 second';

DROP TRIGGER IF EXISTS github_deliveries_set_updated_at ON github_webhook_deliveries;

CREATE TRIGGER github_deliveries_set_updated_at
BEFORE UPDATE ON github_webhook_deliveries
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS github_deliveries_reclaim_idx
ON github_webhook_deliveries(status, updated_at)
WHERE status IN ('received', 'processing', 'failed');
