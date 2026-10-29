import { Database } from "bun:sqlite";
import { migrate } from "./migrations/migrate";

/**
 * Open the server's SQLite database and bring its schema up to date (the
 * numbered migrations in `migrations/` are applied once each, see
 * `migrations/migrate.ts`).
 */
export function openDatabase(databaseFile: string): Database {
    const db = new Database(databaseFile);
    migrate(db);
    return db;
}
