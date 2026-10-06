-- Phase 10 Step 2: identity foundation (users).
-- Forward-only; does not modify any existing table.
-- Step 3 (project ownership) will add project_members referencing users(id).
-- No seed users are created here; no existing data is touched.

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Stored normalized (trimmed + lowercased) by convention in userService.
    -- DB invariants are deliberately narrow: length, no whitespace, contains '@'.
    -- Strict format validation lives in application code.
    email TEXT NOT NULL
        CHECK (
            char_length(email) BETWEEN 3 AND 254
            AND email !~ '\s'
            AND position('@' IN email) > 1
        ),
    -- bcrypt hashes are 60 chars ($2b$...). The lower bound is a backstop so a
    -- short plaintext password can never be stored in this column by mistake.
    password_hash TEXT NOT NULL
        CHECK (char_length(password_hash) BETWEEN 50 AND 255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Case-insensitive uniqueness enforced at the DB level, independent of
-- application normalization: 'User@Example.com' and 'user@example.com'
-- conflict even if a caller bypasses normalizeEmail().
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
ON users (lower(email));
