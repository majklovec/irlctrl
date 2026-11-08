-- Project scoping: every entity (dashboards, overlays, assets) and every
-- device token belongs to a project, not just to a user. The `project_id`
-- columns are added nullable and then back-filled from the legacy `owner`
-- (login) column, so existing data keeps working. Scoping is enforced at the
-- query layer (SQLite cannot add a NOT NULL constraint to an existing column
-- in place).
--
-- Data migration: each existing user gains a single "Personal" project
-- (the deterministic id `personal-<user id>`, the `is_personal` flag left for
-- legacy rows), becomes its sole owner, and all of their legacy `owner`-scoped
-- entities + device tokens are re-parented into it. Users created after this
-- migration get no auto-created project: they make one explicitly from the
-- UI, so this seeding loop is a no-op for a fresh database.

-- Flag marking the auto-created per-user project (never rename/deletable UX).
ALTER TABLE projects
    ADD COLUMN is_personal INTEGER NOT NULL DEFAULT 0;

-- Entity scoping columns (nullable; back-filled below).
ALTER TABLE dashboards
    ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE overlays
    ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE asset_folders
    ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE asset_files
    ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;

-- Device tokens move from user-scoped to project-scoped.
ALTER TABLE tokens
    ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS dashboards_project
    ON dashboards(project_id);
CREATE INDEX IF NOT EXISTS overlays_project
    ON overlays(project_id);
CREATE INDEX IF NOT EXISTS asset_folders_project
    ON asset_folders(project_id);
CREATE INDEX IF NOT EXISTS asset_files_project
    ON asset_files(project_id);
CREATE INDEX IF NOT EXISTS tokens_project
    ON tokens(project_id);

-- One Personal project per user (idempotent by the deterministic id).
INSERT INTO projects (id, name, owner_id, is_personal)
    SELECT printf('personal-%d', u.id), 'Personal', u.id, 1
    FROM users u
    WHERE NOT EXISTS (
        SELECT 1 FROM projects p WHERE p.id = printf('personal-%d', u.id)
    );

INSERT INTO project_members (project_id, user_id, role)
    SELECT printf('personal-%d', m.id), m.id, 'owner'
    FROM users m
    WHERE NOT EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = printf('personal-%d', m.id)
          AND pm.user_id = m.id
    );

-- Re-parent legacy entities + tokens onto the owner's Personal project.
UPDATE dashboards
    SET project_id = printf('personal-%d',
        (SELECT id FROM users WHERE login = dashboards.owner))
    WHERE project_id IS NULL;

UPDATE overlays
    SET project_id = printf('personal-%d',
        (SELECT id FROM users WHERE login = overlays.owner))
    WHERE project_id IS NULL;

UPDATE asset_folders
    SET project_id = printf('personal-%d',
        (SELECT id FROM users WHERE login = asset_folders.owner))
    WHERE project_id IS NULL;

UPDATE asset_files
    SET project_id = printf('personal-%d',
        (SELECT id FROM users WHERE login = asset_files.owner))
    WHERE project_id IS NULL;

UPDATE tokens
    SET project_id = printf('personal-%d', tokens.user_id)
    WHERE project_id IS NULL;
