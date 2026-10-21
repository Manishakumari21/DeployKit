CREATE TABLE IF NOT EXISTS gateway_sync_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at TIMESTAMPTZ,
    locked_by VARCHAR(255),
    lease_expires_at TIMESTAMPTZ,
    lease_token UUID,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT gateway_sync_requests_status_valid
        CHECK (status IN ('pending', 'running', 'done', 'failed')),
    CONSTRAINT gateway_sync_requests_attempts_valid
        CHECK (attempts >= 0),
    CONSTRAINT gateway_sync_requests_max_attempts_valid
        CHECK (max_attempts > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS gateway_sync_requests_pending_project_idx
    ON gateway_sync_requests (project_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS gateway_sync_requests_claim_idx
    ON gateway_sync_requests (available_at, created_at)
    WHERE status = 'pending';
