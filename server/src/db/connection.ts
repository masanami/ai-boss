import Database from "better-sqlite3";

const DEFAULT_DB_PATH = "./data/ai-boss.db";

/**
 * Opens a SQLite connection and enables foreign key enforcement.
 *
 * @param dbPath - Path to the SQLite file, or `:memory:` for an in-memory
 *   database. Falls back to the `DB_PATH` environment variable, then to a
 *   local default path.
 */
export function openDatabase(
  dbPath: string = process.env.DB_PATH ?? DEFAULT_DB_PATH,
): Database.Database {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}
