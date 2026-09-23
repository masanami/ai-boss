import Database from "@tauri-apps/plugin-sql";

// 項目 2: server/src/db/migrate.ts の tasks テーブル（現行列）相当を作成し、読み書きする。
const CREATE_TASKS = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'work',
  priority TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'paused', 'done', 'dropped')),
  boss_comment TEXT,
  estimated_minutes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  evidence_required INTEGER NOT NULL DEFAULT 0,
  committed_start_at TEXT,
  committed_at TEXT
)`;

interface TaskRow { id: number; title: string; status: string; evidence_required: number; created_at: string }

export async function runSqliteCheck() {
  const t0 = performance.now();
  const db = await Database.load("sqlite:aiboss-spike.db");
  await db.execute(CREATE_TASKS);
  const now = new Date().toISOString();
  const inserted = await db.execute(
    "INSERT INTO tasks (title, category, status, created_at, updated_at, evidence_required) VALUES ($1, 'work', 'todo', $2, $2, $3)",
    ["スパイク: 資料作成", now, 1],
  );
  await db.execute("UPDATE tasks SET status = 'in_progress', updated_at = $1 WHERE id = $2", [now, inserted.lastInsertId]);
  const rows = await db.select<TaskRow[]>("SELECT id, title, status, evidence_required, created_at FROM tasks ORDER BY created_at ASC, id ASC");
  const countBefore = rows.length;

  // better-sqlite3 の db.transaction() 相当を BEGIN/ROLLBACK で再現できるか（プールされた接続で文ごとに別接続になると壊れる）
  let transactionProbe: string;
  try {
    await db.execute("BEGIN");
    await db.execute("INSERT INTO tasks (title, created_at, updated_at) VALUES ('rollback-probe', $1, $1)", [now]);
    await db.execute("ROLLBACK");
    const probe = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM tasks WHERE title = 'rollback-probe'");
    transactionProbe = probe[0].n === 0 ? "rollback-effective" : `rollback-NOT-effective (rows=${probe[0].n})`;
  } catch (e) {
    transactionProbe = `error: ${String(e)}`;
  }
  const elapsedMs = Math.round(performance.now() - t0);
  return { ok: rows.some((r) => r.id === inserted.lastInsertId && r.status === "in_progress"), countBefore, lastInsertId: inserted.lastInsertId, sample: rows.slice(-2), transactionProbe, elapsedMs };
}
