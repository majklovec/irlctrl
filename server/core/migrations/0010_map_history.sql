-- Live map route history (TODO/09-map.md `keep_history`). A phone pushes its
-- GPS position as an overlay variable (bound to a keep_history live_map's
-- centerPosition "lon,lat" string) and the server records every position batch
-- into the live `default` route (opened on the first fix). `path.end/<name>`
-- renames the current `default` route to `name` (archiving that segment); the
-- next fix then starts a fresh `default` route. The OBS runtime page fetches
-- the history through the owner-token endpoint and draws the `default` route.
CREATE TABLE IF NOT EXISTS map_paths (
    id TEXT PRIMARY KEY,
    overlay_id TEXT NOT NULL,
    name TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS map_paths_overlay
    ON map_paths(overlay_id, started_at);

CREATE TABLE IF NOT EXISTS map_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    overlay_id TEXT NOT NULL,
    path_id TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS map_points_overlay
    ON map_points(overlay_id, recorded_at);
