CREATE TYPE release_status AS ENUM (
    'pending',
    'starting',
    'healthy',
    'active',
    'stopped',
    'failed'
);

CREATE TYPE runtime_instance_status AS ENUM (
    'starting',
    'running',
    'unhealthy',
    'stopped',
    'failed'
);


CREATE TABLE releases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    deployment_id UUID NOT NULL
        REFERENCES deployments(id)
        ON DELETE CASCADE,

    project_id UUID NOT NULL
        REFERENCES projects(id)
        ON DELETE CASCADE,

    image_repository VARCHAR(500) NOT NULL,

    image_digest VARCHAR(255) NOT NULL,

    status release_status NOT NULL DEFAULT 'pending',

    supersedes_release_id UUID
        REFERENCES releases(id)
        ON DELETE SET NULL,

    error_code VARCHAR(100),

    error_message TEXT,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    started_at TIMESTAMP WITH TIME ZONE,

    healthy_at TIMESTAMP WITH TIME ZONE,

    activated_at TIMESTAMP WITH TIME ZONE,

    stopped_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT releases_deployment_unique
        UNIQUE (deployment_id)
);


CREATE INDEX releases_project_created_idx
ON releases(project_id, created_at DESC);


CREATE INDEX releases_project_status_idx
ON releases(project_id, status);


CREATE INDEX releases_digest_idx
ON releases(image_digest);


CREATE UNIQUE INDEX releases_one_active_per_project_idx
ON releases(project_id)
WHERE status = 'active';


CREATE TABLE runtime_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    release_id UUID NOT NULL
        REFERENCES releases(id)
        ON DELETE CASCADE,

    status runtime_instance_status NOT NULL DEFAULT 'starting',

    container_name VARCHAR(255) NOT NULL,

    container_id VARCHAR(128),

    container_port INTEGER NOT NULL,

    host_port INTEGER NOT NULL,

    health_path VARCHAR(500) NOT NULL DEFAULT '/',

    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    started_at TIMESTAMP WITH TIME ZONE,

    last_health_check_at TIMESTAMP WITH TIME ZONE,

    stopped_at TIMESTAMP WITH TIME ZONE,

    error_code VARCHAR(100),

    error_message TEXT,

    CONSTRAINT runtime_container_port_valid
        CHECK (
            container_port BETWEEN 1 AND 65535
        ),

    CONSTRAINT runtime_host_port_valid
        CHECK (
            host_port BETWEEN 1 AND 65535
        ),

    CONSTRAINT runtime_container_name_unique
        UNIQUE (container_name)
);


CREATE INDEX runtime_instances_release_idx
ON runtime_instances(release_id);


CREATE INDEX runtime_instances_status_idx
ON runtime_instances(status);


CREATE UNIQUE INDEX runtime_instances_container_id_idx
ON runtime_instances(container_id)
WHERE container_id IS NOT NULL;

ALTER TABLE deployments
ADD COLUMN release_id UUID
    REFERENCES releases(id)
    ON DELETE SET NULL;


CREATE UNIQUE INDEX deployments_release_unique_idx
ON deployments(release_id)
WHERE release_id IS NOT NULL;
