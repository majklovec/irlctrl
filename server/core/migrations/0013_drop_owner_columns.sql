-- Remove the legacy per-user `owner` column now that scoping runs entirely on
-- `project_id` (migration 0012). The `owner` columns are NOT NULL, so the
-- stores' project-scoped INSERTs (which no longer write them) would fail the
-- constraint; owner-based indexes are dropped too, and the composite
-- (owner, …) indexes are rebuilt on (project_id, …) so lookups stay indexed.
--
-- Safe in one transaction: each `owner` column is only read back through the
-- index we drop just before the `DROP COLUMN` (SQLite 3.35+ in-place drop).

-- dashboards: no owner index.
ALTER TABLE dashboards
    DROP COLUMN owner;

-- overlays: single-column owner index.
DROP INDEX overlays_owner;
ALTER TABLE overlays
    DROP COLUMN owner;

-- asset_folders: (owner, parent_id) → (project_id, parent_id).
DROP INDEX asset_folders_owner_parent;
CREATE INDEX IF NOT EXISTS asset_folders_project_parent
    ON asset_folders(project_id, parent_id);
ALTER TABLE asset_folders
    DROP COLUMN owner;

-- asset_files: (owner, folder_id) → (project_id, folder_id).
DROP INDEX asset_files_owner_folder;
CREATE INDEX IF NOT EXISTS asset_files_project_folder
    ON asset_files(project_id, folder_id);
ALTER TABLE asset_files
    DROP COLUMN owner;
