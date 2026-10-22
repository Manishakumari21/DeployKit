ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS build_config JSONB;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'projects_build_config_object'
    ) THEN
        ALTER TABLE projects
            ADD CONSTRAINT projects_build_config_object
            CHECK (build_config IS NULL OR jsonb_typeof(build_config) = 'object');
    END IF;
END
$$;
