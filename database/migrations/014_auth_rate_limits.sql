-- Phase 10 final: bounded PostgreSQL-backed auth rate limiting.
-- Forward-only. One row per (key, window); windows expire lazily and are
-- swept opportunistically by the limiter, so the table stays tiny and no
-- background job or unbounded growth is possible.

CREATE TABLE IF NOT EXISTS auth_rate_limits (
    key TEXT PRIMARY KEY,
    window_start TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    count INTEGER NOT NULL DEFAULT 1
        CHECK (count >= 1)
);

-- Expiry sweeps: DELETE ... WHERE window_start < cutoff.
CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx
ON auth_rate_limits (window_start);
