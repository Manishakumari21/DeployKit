CREATE TABLE project_gateways (
    project_id UUID PRIMARY KEY
        REFERENCES projects(id)
        ON DELETE CASCADE,

    gateway_name VARCHAR(128) NOT NULL,

    active_release_id UUID
        REFERENCES releases(id)
        ON DELETE SET NULL,

    target_container VARCHAR(128) NOT NULL,

    target_ip VARCHAR(45) NOT NULL,

    target_port INTEGER NOT NULL,

    config_rev BIGINT NOT NULL DEFAULT 0,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT project_gateway_port_valid
        CHECK (
            target_port BETWEEN 1 AND 65535
        )
);


CREATE INDEX project_gateways_release_idx
ON project_gateways(active_release_id)
WHERE active_release_id IS NOT NULL;


DROP TRIGGER IF EXISTS project_gateways_set_updated_at ON project_gateways;

CREATE TRIGGER project_gateways_set_updated_at
BEFORE UPDATE ON project_gateways
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

ALTER TABLE runtime_instances
ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45);
