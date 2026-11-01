-- Invite-only onboarding + admin user management. Additive only.
--
-- Adds a global role and a disable flag to users, plus an invites table so an
-- admin can onboard new users by issuing a single-use, expiring invite token.
-- The bootstrap first user on a fresh server becomes the first admin; on an
-- existing database the earliest account is promoted so an admin always exists.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('admin', 'member'));

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMP WITH TIME ZONE;

-- Promote the earliest account to admin when none exists yet.
UPDATE users
SET role = 'admin'
WHERE id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');

CREATE TABLE IF NOT EXISTS invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    email TEXT NOT NULL
        CHECK (
            char_length(email) BETWEEN 3 AND 254
            AND email !~ '\s'
            AND position('@' IN email) > 1
        ),

    -- Peppered HMAC-SHA-256 (64 hex chars) of the opaque invite token; the raw
    -- token is shown to the admin once and never stored.
    token_hash TEXT NOT NULL UNIQUE
        CHECK (char_length(token_hash) = 64),

    invited_by UUID
        REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,

    accepted_at TIMESTAMP WITH TIME ZONE,
    accepted_user_id UUID
        REFERENCES users(id) ON DELETE SET NULL,

    revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS invites_email_idx
ON invites (lower(email));

CREATE INDEX IF NOT EXISTS invites_pending_idx
ON invites (expires_at)
WHERE accepted_at IS NULL AND revoked_at IS NULL;
