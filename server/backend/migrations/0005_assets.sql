-- Assets manager: per-user folder tree + file storage. Each user gets a single
-- "Root" folder (created lazily by the store); folders nest via parent_id.
-- File bytes ride in the database as BLOBs (the `dashboards.widgets` blob
-- precedent) — a control server works with modest file sizes.
CREATE TABLE IF NOT EXISTS asset_folders (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS asset_folders_owner_parent
    ON asset_folders(owner, parent_id);

CREATE TABLE IF NOT EXISTS asset_files (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS asset_files_owner_folder
    ON asset_files(owner, folder_id);
