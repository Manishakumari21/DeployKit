-- Phase 10 Step 4: database-backed opaque sessions.
-- Forward-only. Touches no existing table and no existing rows.
--
-- Token design: the API issues a 256-bit random token (hex) and stores only
-- its SHA-256 digest here. A database read never yields a usable session, and
-- lookup is by exact digest match. Expiry and revocation are enforced on
-- every resolution; no seed rows are created by this migration.

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- SHA-256 hex digest (64 chars) of the opaque token. UNIQUE doubles as
    -- the lookup index; the length CHECK rejects truncated/plaintext values.
    token_hash TEXT NOT NULL UNIQUE
        CHECK (char_length(token_hash) = 64),
    user_id UUID NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Set on logout/explicit revocation. NULL means not revoked.
    revoked_at TIMESTAMP WITH TIME ZONE
);

-- All sessions belonging to a user (logout-everywhere, audit).
CREATE INDEX IF NOT EXISTS sessions_user_idx
ON sessions (user_id);

-- Expiration sweeps: DELETE ... WHERE expires_at < NOW().
CREATE INDEX IF NOT EXISTS sessions_expires_idx
ON sessions (expires_at);
