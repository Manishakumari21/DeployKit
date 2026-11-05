-- Per-PR preview deployments: shadow projects and trigger enum extension

ALTER TYPE deployment_trigger ADD VALUE IF NOT EXISTS 'github_pull_request';

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS parent_project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS pr_number INTEGER,
    ADD COLUMN IF NOT EXISTS is_preview BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS preview_deployments_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS projects_parent_pr_idx
ON projects (parent_project_id, pr_number)
WHERE parent_project_id IS NOT NULL;

-- Edge-agent runtimes report no host port when port publishing is disabled.
ALTER TABLE runtime_instances
    ALTER COLUMN host_port DROP NOT NULL;
