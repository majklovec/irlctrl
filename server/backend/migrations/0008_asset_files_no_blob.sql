-- Asset files live on disk only (the `--storage`/`STORAGE_DIR` directory).
-- The legacy `data` BLOB column — kept after 0007 as a fallback for files
-- uploaded before the disk migration — is dropped now that the embedded/
-- BLOB asset paths are gone: files that only exist in the database have no
-- serving path left, so the column is pure dead weight. (SQLite cannot drop
-- a column in place before 3.35, hence the table rebuild — every row is
-- carried over.)
CREATE TABLE asset_files_disk (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

INSERT INTO asset_files_disk (id, owner, folder_id, name, size, mime_type, created_at, updated_at)
    SELECT id, owner, folder_id, name, size, mime_type, created_at, updated_at
    FROM asset_files;

DROP TABLE asset_files;

ALTER TABLE asset_files_disk RENAME TO asset_files;

CREATE INDEX IF NOT EXISTS asset_files_owner_folder
    ON asset_files(owner, folder_id);
