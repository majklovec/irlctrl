import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The server's SQLite schema lives in the numbered `.sql` migrations in
 * `migrations/` (applied in file-name order, once per startup). Each
 * migration runs exactly once: applied file names are tracked in the
 * `schema_migrations` table, which makes `ALTER TABLE`-style changes safe
 * without per-column checks at the call site.
 *
 * To change the schema, add a new `NNNN_<name>.sql` file to `migrations/` —
 * never edit an applied migration (its name is what the tracker compares
 * against).
 */
const MIGRATIONS_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "migrations",
);

/** Apply every unapplied migration from the `migrations/` directory. */
function migrate(db: Database): void {
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

    for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        if (applied.has(file)) continue;
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
        db.transaction(() => {
            db.run(sql);
            db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(
                file,
            );
        })();
    }
}

/** Open the server's SQLite database and bring its schema up to date. */
export function openDatabase(databaseFile: string): Database {
    const db = new Database(databaseFile);
    migrate(db);
    return db;
}
