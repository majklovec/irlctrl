-- General-purpose projects (TODO/01-projects.md): a user can own or join
-- multiple projects through invite links; members carry a role
-- (owner / editor / viewer). `projects.owner_id` mirrors the single
-- `owner` row in `project_members` (kept for cheap "who owns this"
-- queries and cascade safety). Deliberately distinct from the OBS
-- `overlay_projects` table and from the registration `invitations`
-- table — new invites live in `project_invites`.
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS project_members_user
    ON project_members(user_id);

-- Invite links: single-use, 7-day expiry by default (NULL = no expiry).
CREATE TABLE IF NOT EXISTS project_invites (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_at DATETIME
);

CREATE INDEX IF NOT EXISTS project_invites_project
    ON project_invites(project_id);
