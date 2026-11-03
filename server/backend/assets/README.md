# Assets manager

Per-user file storage for the control server: a single-root folder tree plus
the files of the selected folder, served from `/assets/` and exposed through
`/api/assets/*`.

## Data model

- `asset_folders` — `id`, `owner`, `parent_id`, `name`, `created_at` (ms).
  Each user gets one lazily-created `Root` folder (`parent_id IS NULL`);
  folders nest up to a depth of 16.
- `asset_files` — `id`, `owner`, `folder_id`, `name`, `size`, `mime_type`,
  `data` (BLOB, nullable), `created_at`, `updated_at` (ms). File bytes live on
  disk in the storage directory — one file per asset, named by its id
  (`<storage>/<id>`, flat) — and the database keeps only the metadata. The
  `data` column is the fallback for rows uploaded before the disk migration
  (they keep serving from the BLOB when no disk file exists). Uploads are
  capped at 200 MB each.

The storage directory is the `--storage` / `STORAGE_DIR` option (default
`assets`, created on first upload). Deleting a file or folder also removes
its disk file.

Every query is scoped by `owner` — a user can only list, create, rename,
move, delete, download or inspect their own folders and files. Foreign ids
come back as 404 (no existence leaks). See `server/backend/assets/asset_store.ts`
for the full API surface.

## Endpoints

| Method | Path                       | Purpose                                        |
| ------ | -------------------------- | ---------------------------------------------- |
| GET    | `/assets/`                 | The assets manager page                        |
| GET    | `/api/assets/folders`      | Child folders (`?parent=<id>`, root list w/o)  |
| GET    | `/api/assets/folders/all`  | Every folder of the user (move picker)         |
| POST   | `/api/assets/folders`      | `{parentId, name}`                             |
| PATCH  | `/api/assets/folders/:id`  | `{name}` rename or `{parentId}` move           |
| DELETE | `/api/assets/folders/:id`  | Delete recursively                             |
| GET    | `/api/assets/files`        | Files of a folder (`?folderId=<id>`)           |
| GET    | `/api/assets/browse`       | Media files of the whole tree with folder path (`?kind=image\|video\|audio`; the overlay editor's picker) |
| POST   | `/api/assets/files`        | Multipart: `folderId` field + `files` parts    |
| GET    | `/api/assets/file-meta/:id`| File metadata (no bytes)                       |
| GET    | `/api/assets/files/:id`    | The file bytes (RFC 5987 attachment download)  |
| PATCH  | `/api/assets/files/:id`    | `{name}` rename or `{folderId}` move           |
| DELETE | `/api/assets/files/:id`    | Delete                                         |

Wire format: `Folder` = `{ id, parentId, name, createdAt, hasChildren,
fileCount }`, `AssetFile` = `{ id, folderId, name, size, mimeType, createdAt,
updatedAt }` (timestamps in epoch ms). Uploads auto-suffix name collisions as
`name (n).ext`; rename/move into a taken name is a 409.

## Frontend

`server/frontend/ts/assets/` — `assets_store.ts` (lazy tree state, per-folder
file cache, all mutations) and `assets_list.tsx` (keyboard-navigable tree,
file table, drag-and-drop upload and move, modals). Styles:
`shared/css/pages/assets.css`. i18n: `assets.*` keys in `i18n/*.json`.
