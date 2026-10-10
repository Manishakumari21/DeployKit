CREATE TYPE deployment_status AS ENUM (
    'queued',
    'cloning',
    'building',
    'pushing',
    'deploying',
    'verifying',
    'active',
    'failed',
    'cancelled'
);

CREATE TYPE deployment_trigger AS ENUM (
    'manual',
    'github_push',
    'rollback'
);

CREATE TYPE job_status AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled'
);

CREATE TABLE deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    project_id UUID NOT NULL
        REFERENCES projects(id)
        ON DELETE CASCADE,

    status deployment_status NOT NULL DEFAULT 'queued',

    trigger deployment_trigger NOT NULL DEFAULT 'manual',

    branch VARCHAR(255) NOT NULL,

    commit_sha VARCHAR(64),

    image_repository VARCHAR(500),

    image_digest VARCHAR(255),

    error_code VARCHAR(100),

    error_message TEXT,

    idempotency_key VARCHAR(255),

    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    started_at TIMESTAMP WITH TIME ZONE,

    finished_at TIMESTAMP WITH TIME ZONE,

    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX deployments_project_idempotency_idx
ON deployments(project_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX deployments_project_created_idx
ON deployments(project_id, created_at DESC);

CREATE INDEX deployments_status_created_idx
ON deployments(status, created_at);

CREATE TABLE deployment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    deployment_id UUID NOT NULL
        REFERENCES deployments(id)
        ON DELETE CASCADE,

    attempt_number INTEGER NOT NULL,

    status deployment_status NOT NULL,

    worker_id VARCHAR(255),

    error_code VARCHAR(100),

    error_message TEXT,

    started_at TIMESTAMP WITH TIME ZONE,

    finished_at TIMESTAMP WITH TIME ZONE,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT deployment_attempt_number_positive
        CHECK (attempt_number > 0),

    CONSTRAINT deployment_attempt_unique
        UNIQUE (deployment_id, attempt_number)
);

CREATE INDEX deployment_attempts_deployment_idx
ON deployment_attempts(deployment_id, attempt_number DESC);

CREATE TABLE deployment_events (
    id BIGSERIAL PRIMARY KEY,

    deployment_id UUID NOT NULL
        REFERENCES deployments(id)
        ON DELETE CASCADE,

    event_type VARCHAR(100) NOT NULL,

    status_from deployment_status,

    status_to deployment_status,

    message TEXT,

    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX deployment_events_deployment_created_idx
ON deployment_events(deployment_id, created_at);

CREATE TABLE deployment_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    deployment_id UUID NOT NULL
        REFERENCES deployments(id)
        ON DELETE CASCADE,

    status job_status NOT NULL DEFAULT 'queued',

    attempts INTEGER NOT NULL DEFAULT 0,

    max_attempts INTEGER NOT NULL DEFAULT 3,

    available_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    locked_at TIMESTAMP WITH TIME ZONE,

    locked_by VARCHAR(255),

    last_error TEXT,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT deployment_job_attempts_valid
        CHECK (attempts >= 0),

    CONSTRAINT deployment_job_max_attempts_valid
        CHECK (max_attempts > 0)
);

CREATE UNIQUE INDEX deployment_jobs_deployment_idx
ON deployment_jobs(deployment_id);

CREATE INDEX deployment_jobs_poll_idx
ON deployment_jobs(status, available_at);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deployments_set_updated_at
BEFORE UPDATE ON deployments
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER deployment_jobs_set_updated_at
BEFORE UPDATE ON deployment_jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
