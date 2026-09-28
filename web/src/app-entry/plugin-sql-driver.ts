import type { DbDriver, RunResult, SqlValue } from "../../../server/src/core-entry.js";

/**
 * 製品版の DB のドライバ（#580 S2・機能仕様 docs/features/async-db-layer.md
 * 「S2 の設計」）。`@tauri-apps/plugin-sql` の `Database`（Rust 側はリポジトリ
 * 内 fork で接続 1 本）の上で、S1 の `DbDriver` の契約（1 本の接続の上で文を
 * 実行するだけ）を満たす。ロック・トランザクションの意味は直列化層
 * （`createSerializedDb`）が持つ。
 *
 * `@tauri-apps/plugin-sql` に依存するのは製品版だけなので、コア
 * （`server/src`）ではなく製品版の web のエントリの側に置く。
 */

/** plugin-sql の `Database` のうち、このドライバが使う口（テストで差し替える）。 */
export interface PluginSqlDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
}

export function createPluginSqlDriver(database: PluginSqlDatabase): DbDriver {
  return {
    async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
      const result = await database.execute(sql, params);
      return {
        changes: result.rowsAffected,
        // SQLite の実装では常に返る（仮定 A10）。
        lastInsertRowid: result.lastInsertId ?? 0,
      };
    },
    async get<T = unknown>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
      const rows = await database.select<T[]>(sql, params);
      return rows[0];
    },
    all<T = unknown>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      return database.select<T[]>(sql, params);
    },
    async exec(sql: string): Promise<void> {
      await database.execute(sql);
    },
  };
}
