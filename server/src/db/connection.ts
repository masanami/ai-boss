import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * Ensures the parent directory of a file-based db path exists. No-op for
 * the special `:memory:` path. `mkdirSync` with `recursive: true` does not
 * throw when the directory already exists, so no existence check is needed.
 */
function ensureParentDirectoryExists(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }

  mkdirSync(dirname(dbPath), { recursive: true });
}

/**
 * Opens a SQLite connection and enables foreign key enforcement.
 *
 * @param dbPath - Path to the SQLite file, or `:memory:` for an in-memory
 *   database. Default resolution (env var / fallback path) is the
 *   responsibility of the caller (see `config.ts`). The parent directory is
 *   created if it does not exist yet.
 */
export function openDatabase(dbPath: string): Database.Database {
  ensureParentDirectoryExists(dbPath);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}
