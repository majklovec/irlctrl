-- OBS overlay editor: one row per OVERLAY (replaces `overlay_projects`, which
-- held one project per user). An overlay is self-contained — its own canvas,
-- variables, assets, elements and, crucially, its own `token` (protecting its
-- runtime pages, the chat-overlay pattern). A user may have many overlays.
--
-- Data migration: each legacy `overlay_projects` row is split into one row per
-- scene (the scene's elements promote into the overlay's root), each with a
-- fresh token. That backfill runs in `overlay_store.ts` load() AFTER this table
-- is created, then the legacy `overlay_projects` table is dropped (no backward
-- compatibility is kept).
CREATE TABLE IF NOT EXISTS overlays (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL,
    token TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);

-- tokens are unique across all overlays (each overlay has its own)
CREATE UNIQUE INDEX IF NOT EXISTS overlays_token
    ON overlays(token);

-- the editor list page fetches a user's overlays
CREATE INDEX IF NOT EXISTS overlays_owner
    ON overlays(owner);
