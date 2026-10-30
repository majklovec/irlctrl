-- OBS overlay editor: one project row per user (the whole project is a JSON
-- blob, the same precedent as `dashboards.widgets`). The token protects the
-- token-authenticated runtime pages (chat-overlay pattern).
CREATE TABLE IF NOT EXISTS overlay_projects (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL,
    token TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS overlay_projects_token
    ON overlay_projects(token);
