

CREATE TABLE IF NOT EXISTS project_members (
    project_id UUID NOT NULL
        REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,

    role TEXT NOT NULL
        CHECK (role IN ('owner')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS project_members_user_idx
ON project_members (user_id);
