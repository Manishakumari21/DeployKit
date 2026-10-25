-- Phase 3: Error Intelligence. Additive only: one new table plus indexes.
-- An incident is a durable record of a failure signal observed by a detector
-- (deployment failure, unhealthy runtime, failed gateway sync, TLS failure or
-- expiry, failed GitHub webhook delivery). Detectors upsert idempotently by
-- (project_id, subject_key); resolved incidents are never rewritten, recurrence
-- creates a new row.

CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    project_id UUID NOT NULL
        REFERENCES projects(id) ON DELETE CASCADE,

    kind TEXT NOT NULL
        CHECK (kind IN (
            'deployment_failure',
            'runtime_unhealthy',
            'gateway_sync_failed',
            'tls_failure',
            'webhook_failed'
        )),

    -- Stable identity of the failing subject, e.g. "deployment:<uuid>",
    -- "runtime:<uuid>", "gateway:<project_id>", "tls:<domain_id>",
    -- "webhook:<delivery_id>".
    subject_key TEXT NOT NULL
        CHECK (char_length(subject_key) BETWEEN 1 AND 200),

    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'acknowledged', 'resolved')),

    severity TEXT NOT NULL DEFAULT 'warning'
        CHECK (severity IN ('warning', 'critical')),

    title TEXT NOT NULL
        CHECK (char_length(title) BETWEEN 1 AND 200),

    detail TEXT,

    error_code VARCHAR(100),

    -- Bounded, redacted snapshot of the evidence behind the incident.
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(evidence) = 'object'),

    -- Identity of the most recent signal counted for this incident. A repeated
    -- sweep with the same token is idempotent; a changed token is a new signal
    -- and increments occurrence_count exactly once.
    signal_token TEXT,

    -- Source timestamp of the newest counted signal; used to refuse reopening
    -- from evidence that predates a recovery.
    source_timestamp TIMESTAMP WITH TIME ZONE,

    occurrence_count INTEGER NOT NULL DEFAULT 1
        CHECK (occurrence_count >= 1),

    first_seen_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    acknowledged_at TIMESTAMP WITH TIME ZONE,

    acknowledged_by UUID
        REFERENCES users(id) ON DELETE SET NULL,

    resolved_at TIMESTAMP WITH TIME ZONE,

    resolution TEXT
        CHECK (resolution IS NULL OR resolution IN ('manual', 'auto')),

    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT incidents_resolved_fields_valid
        CHECK (
            (status = 'resolved' AND resolved_at IS NOT NULL
                AND resolution IS NOT NULL)
            OR
            (status <> 'resolved' AND resolved_at IS NULL
                AND resolution IS NULL)
        )
);

-- At most one non-resolved incident per subject; resolved history is kept.
CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_subject_unique
ON incidents (project_id, subject_key)
WHERE status <> 'resolved';

CREATE INDEX IF NOT EXISTS incidents_subject_idx
ON incidents (project_id, subject_key);

CREATE INDEX IF NOT EXISTS incidents_project_open_idx
ON incidents (project_id, status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS incidents_kind_idx
ON incidents (kind, status);

DROP TRIGGER IF EXISTS incidents_set_updated_at ON incidents;

CREATE TRIGGER incidents_set_updated_at
BEFORE UPDATE ON incidents
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
