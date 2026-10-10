

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    email TEXT NOT NULL
        CHECK (
            char_length(email) BETWEEN 3 AND 254
            AND email !~ '\s'
            AND position('@' IN email) > 1
        ),

    password_hash TEXT NOT NULL
        CHECK (char_length(password_hash) BETWEEN 50 AND 255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
ON users (lower(email));
