

CREATE TABLE IF NOT EXISTS deployment_logs (
    id BIGSERIAL PRIMARY KEY,
    deployment_id UUID NOT NULL
        REFERENCES deployments(id)
        ON DELETE CASCADE,
    project_id UUID NOT NULL
        REFERENCES projects(id)
        ON DELETE CASCADE,
    source TEXT NOT NULL
        CHECK (source IN ('system','git','build','registry','runtime','healthcheck','worker','gateway')),
    level TEXT NOT NULL
        CHECK (level IN ('debug','info','warn','error')),
    message TEXT NOT NULL
        CHECK (char_length(message) BETWEEN 1 AND 65536),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS deployment_logs_deployment_id_idx
ON deployment_logs(deployment_id, id ASC);

CREATE INDEX IF NOT EXISTS deployment_logs_project_created_idx
ON deployment_logs(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS deployment_logs_created_idx
ON deployment_logs(created_at);
