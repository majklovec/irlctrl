-- Asset files move to disk: new uploads are written to the server's storage
-- directory (the `--storage`/`STORAGE_DIR` option, `assets/<file id>`), so the
-- database no longer bloats with media BLOBs. The `data` column stays, now
-- nullable, as a fallback for files uploaded before this change: rows with
-- bytes and no disk file keep serving from the database. (SQLite cannot make
-- a NOT NULL column nullable in place, hence the table rebuild — every row is
-- carried over.)
CREATE TABLE asset_files_disk (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    data BLOB,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

INSERT INTO asset_files_disk (id, owner, folder_id, name, size, mime_type, data, created_at, updated_at)
    SELECT id, owner, folder_id, name, size, mime_type, data, created_at, updated_at
    FROM asset_files;

DROP TABLE asset_files;

ALTER TABLE asset_files_disk RENAME TO asset_files;

CREATE INDEX IF NOT EXISTS asset_files_owner_folder
    ON asset_files(owner, folder_id);
