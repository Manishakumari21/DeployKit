-- Phase 10 Step 3: project ownership/membership.
-- Forward-only. Does not modify any existing table and touches no existing rows.
--
-- Legacy strategy: projects created before users existed get NO rows here.
-- Absence of rows IS the explicit unowned state (no extra flag column, so the
-- state cannot drift out of sync). Authorization denies access to unowned
-- projects (fail closed); they are never treated as public and ownership is
-- never guessed. Explicit bootstrap: create a real user, then call
-- addProjectOwner(projectId, userId) (idempotent) or run the equivalent
-- INSERT below with explicit UUIDs, and verify with the SELECT.
--
--   INSERT INTO project_members (project_id, user_id, role)
--   VALUES ('<project-uuid>', '<user-uuid>', 'owner')
--   ON CONFLICT (project_id, user_id) DO NOTHING;
--
-- No fake users are created by this migration.

CREATE TABLE IF NOT EXISTS project_members (
    project_id UUID NOT NULL
        REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
    -- Single role today. Future roles extend this list without redesign;
    -- authorization compares role rank, not ad-hoc strings.
    role TEXT NOT NULL
        CHECK (role IN ('owner')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id)
);

-- Project -> members direction is covered by the PRIMARY KEY prefix.
-- This index covers the reverse direction (all projects for a user).
CREATE INDEX IF NOT EXISTS project_members_user_idx
ON project_members (user_id);
