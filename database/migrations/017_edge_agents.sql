CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL
        REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL
        CHECK (char_length(name) BETWEEN 1 AND 100),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'online', 'offline', 'revoked')),
    last_heartbeat_at TIMESTAMP WITH TIME ZONE,
    version TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT agents_project_name_unique
        UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS agents_project_status_idx
ON agents (project_id, status);

CREATE INDEX IF NOT EXISTS agents_heartbeat_idx
ON agents (status, last_heartbeat_at);

DROP TRIGGER IF EXISTS agents_set_updated_at ON agents;
CREATE TRIGGER agents_set_updated_at
BEFORE UPDATE ON agents
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS agent_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL
        REFERENCES agents(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE
        CHECK (char_length(token_hash) = 64),
    revoked_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS agent_credentials_agent_idx
ON agent_credentials (agent_id);

ALTER TABLE deployments
ADD COLUMN IF NOT EXISTS target_agent_id UUID
REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS deployments_target_agent_idx
ON deployments (target_agent_id)
WHERE target_agent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION check_deployment_target_agent_project()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.target_agent_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1
            FROM agents
            WHERE agents.id = NEW.target_agent_id
              AND agents.project_id = NEW.project_id
        ) THEN
            RAISE EXCEPTION
                'target_agent_id belongs to a different project'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deployments_target_agent_project_chk ON deployments;
CREATE TRIGGER deployments_target_agent_project_chk
BEFORE INSERT OR UPDATE OF target_agent_id, project_id ON deployments
FOR EACH ROW
EXECUTE FUNCTION check_deployment_target_agent_project();

ALTER TABLE deployment_jobs
ADD COLUMN IF NOT EXISTS claimed_agent_id UUID
REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS deployment_jobs_claimed_agent_idx
ON deployment_jobs (claimed_agent_id)
WHERE claimed_agent_id IS NOT NULL;
