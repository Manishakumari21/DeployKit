ALTER TABLE deployments
ADD COLUMN IF NOT EXISTS rollback_release_id UUID
REFERENCES releases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS deployments_rollback_release_idx
ON deployments(rollback_release_id)
WHERE rollback_release_id IS NOT NULL;
