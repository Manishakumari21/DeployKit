

CREATE TABLE IF NOT EXISTS auth_rate_limits (
    key TEXT PRIMARY KEY,
    window_start TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    count INTEGER NOT NULL DEFAULT 1
        CHECK (count >= 1)
);

CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx
ON auth_rate_limits (window_start);
