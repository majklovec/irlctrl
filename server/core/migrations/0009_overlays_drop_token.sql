-- Overlays no longer carry a per-overlay runtime token. Runtime pages
-- (OBS Browser Source, chat feed, asset files, variables, events) authenticate
-- with the OWNER's user token and are owner-scoped by overlay id, so the
-- column and its unique index are dead weight (user-token auth, #overlays).
DROP INDEX IF EXISTS overlays_token;
ALTER TABLE overlays DROP COLUMN token;
