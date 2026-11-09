CREATE TABLE IF NOT EXISTS project_env_vars (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key VARCHAR(128) NOT NULL,
    value_encrypted TEXT NOT NULL,
    is_secret BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT project_env_vars_key_unique UNIQUE (project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_project_env_vars_project_id ON project_env_vars(project_id);
