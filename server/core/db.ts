import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appPath } from "../../shared/paths";
import { isCompiledBinary } from "../../shared/util";

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
const MIGRATIONS_DIR = appPath("server/core/migrations");

/**
 * Unapplied migrations as `[name, sql]` pairs in file-name order.
 *
 * Unbundled runs (`bun server/main.ts`, `bun test`) read the files from disk;
 * compiled binaries (`bun build --compile`) read the build-time manifest
 * generated/migrations.ts (scripts/gen_modules.ts), which inlines every
 * `.sql` file — a compiled process cannot readdir (import.meta.url lives in
 * Bun's virtual /$bunfs mount).
 */
async function pendingMigrations(
    applied: Set<string>,
): Promise<[string, string][]> {
    const all: [string, string][] = isCompiledBinary()
        ? Object.entries(
              (await import("../../generated/migrations")).default,
          )
        : readdirSync(MIGRATIONS_DIR)
              .filter((f) => f.endsWith(".sql"))
              .sort()
              .map(
                  (file): [string, string] => [
                      file,
                      readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
                  ],
              );
    return all.filter(([file]) => !applied.has(file));
}

/** Apply every unapplied migration, in file-name order, each in its own transaction. */
async function migrate(db: Database): Promise<void> {
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

    for (const [file, sql] of await pendingMigrations(applied))
        db.transaction(() => {
            db.run(sql);
            db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(
                file,
            );
        })();
}

/** Open the server's SQLite database and bring its schema up to date. */
export async function openDatabase(databaseFile: string): Promise<Database> {
    const db = new Database(databaseFile);
    await migrate(db);
    return db;
}
