import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The server's SQLite schema lives in the numbered `.sql` migrations in this
 * directory (applied in file-name order, one per startup). Each migration
 * runs exactly once: applied file names are tracked in the
 * `schema_migrations` table, which makes `ALTER TABLE`-style changes safe
 * without per-column checks at the call site.
 *
 * To change the schema, add a new `NNNN_<name>.sql` file here — never edit
 * an applied migration (its name is what the tracker compares against).
 */
const DIR = dirname(fileURLToPath(import.meta.url));

export function migrate(db: Database): void {
    db.run(`
CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);
    const applied = new Set(
        (
            db.prepare("SELECT name FROM schema_migrations").all() as {
                name: string;
            }[]
        ).map((row) => row.name),
    );
    // Legacy: before the migration runner existed, auth.ts added the
    // dashboards.color column ad-hoc. Backfill the tracker so 0002 does not
    // (and cannot) re-apply on such databases.
    if (
        !applied.has("0002_dashboards_color.sql") &&
        db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dashboards'",
            )
            .get()
    ) {
        const columns = (
            db.prepare("PRAGMA table_info(dashboards)").all() as {
                name: string;
            }[]
        ).map((c) => c.name);
        if (columns.includes("color")) {
            db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(
                "0002_dashboards_color.sql",
            );
            applied.add("0002_dashboards_color.sql");
        }
    }
    for (const file of readdirSync(DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        if (applied.has(file)) continue;
        const sql = readFileSync(join(DIR, file), "utf8");
        db.transaction(() => {
            db.run(sql);
            db
                .prepare("INSERT INTO schema_migrations (name) VALUES (?)")
                .run(file);
        })();
    }
}
