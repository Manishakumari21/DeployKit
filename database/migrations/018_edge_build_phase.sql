ALTER TABLE deployment_jobs
    ADD COLUMN IF NOT EXISTS job_phase TEXT NOT NULL DEFAULT 'execute',
    ADD COLUMN IF NOT EXISTS build_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS max_build_attempts INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS lease_token UUID;

ALTER TABLE deployment_jobs
    ADD CONSTRAINT deployment_jobs_phase_valid
        CHECK (job_phase IN ('build', 'execute'));

ALTER TABLE deployment_jobs
    ADD CONSTRAINT deployment_jobs_build_attempts_valid
        CHECK (build_attempts >= 0);

ALTER TABLE deployment_jobs
    ADD CONSTRAINT deployment_jobs_max_build_attempts_valid
        CHECK (max_build_attempts > 0);

CREATE INDEX IF NOT EXISTS deployment_jobs_build_claim_idx
    ON deployment_jobs (available_at, created_at)
    WHERE status = 'queued' AND job_phase = 'build';
