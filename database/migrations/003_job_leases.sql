ALTER TABLE deployment_jobs
ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS deployment_jobs_lease_idx
ON deployment_jobs(status, lease_expires_at);
