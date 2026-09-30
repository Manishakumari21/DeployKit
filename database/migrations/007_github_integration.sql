-- Phase 04: GitHub App integration + webhook delivery dedup + project linking.
-- Forward-only; no destructive changes.

CREATE TABLE IF NOT EXISTS github_installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_installation_id BIGINT NOT NULL,
    account_login TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT github_installations_id_unique UNIQUE (github_installation_id)
);

CREATE TABLE IF NOT EXISTS github_repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_repo_id BIGINT,
    installation_id UUID REFERENCES github_installations(id) ON DELETE SET NULL,
    full_name TEXT NOT NULL,
    private BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS github_repositories_repo_id_idx
ON github_repositories(github_repo_id)
WHERE github_repo_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS github_repositories_full_name_idx
ON github_repositories(lower(full_name));

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
    delivery_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    repository_full_name TEXT,
    installation_id BIGINT,
    status TEXT NOT NULL DEFAULT 'received',
    deployment_id UUID REFERENCES deployments(id) ON DELETE SET NULL,
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS github_deliveries_status_idx
ON github_webhook_deliveries(status, created_at DESC);

CREATE INDEX IF NOT EXISTS github_deliveries_repo_idx
ON github_webhook_deliveries(lower(repository_full_name));

-- Project linking: explicit opt-in for auto deploy.
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS auto_deploy BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE projects
ADD COLUMN IF NOT EXISTS github_repository_id UUID
    REFERENCES github_repositories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS projects_github_repo_idx
ON projects(github_repository_id)
WHERE github_repository_id IS NOT NULL;
