
ALTER TABLE releases
ADD COLUMN IF NOT EXISTS commit_sha VARCHAR(64);

ALTER TABLE releases
ADD COLUMN IF NOT EXISTS branch VARCHAR(255);

CREATE INDEX IF NOT EXISTS releases_commit_idx
ON releases(commit_sha);

CREATE INDEX IF NOT EXISTS deployments_project_status_idx
ON deployments(project_id, status);

CREATE INDEX IF NOT EXISTS deployment_jobs_recovery_idx
ON deployment_jobs(status, lease_expires_at, available_at);

CREATE INDEX IF NOT EXISTS runtime_instances_release_status_idx
ON runtime_instances(release_id, status);
