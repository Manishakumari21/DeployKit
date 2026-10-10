

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    token_hash TEXT NOT NULL UNIQUE
        CHECK (char_length(token_hash) = 64),
    user_id UUID NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS sessions_user_idx
ON sessions (user_id);

CREATE INDEX IF NOT EXISTS sessions_expires_idx
ON sessions (expires_at);
