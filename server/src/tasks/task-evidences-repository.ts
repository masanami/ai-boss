import type { Db } from "../db/db-port.js";
import type { TaskEvidence } from "./task-evidence.js";

/**
 * `task_evidences` への INSERT 入力。`kind` で `file` / `link` を判別する
 * ユニオンにし、各 kind で非 null であるべき列を型で強制する（機能仕様
 * docs/features/completion-evidence-enforcement.md 決定 1-b: DB 側の CHECK
 * ではなくサーバ側の検証層でこの整合を担保する方針を、この repository の
 * 入力型でも同じ形で表す）。
 */
export type NewTaskEvidenceRecord =
  | {
      task_id: number;
      kind: "file";
      stored_filename: string;
      original_filename: string;
      mime_type: string;
      size_bytes: number;
    }
  | {
      task_id: number;
      kind: "link";
      url: string;
    };

/** 指定タスクのエビデンスを作成順（id 昇順）で返す。 */
export async function listTaskEvidences(db: Db, taskId: number): Promise<TaskEvidence[]> {
  return db.all<TaskEvidence>("SELECT * FROM task_evidences WHERE task_id = ? ORDER BY id ASC", [
    taskId,
  ]);
}

/** 指定タスクのエビデンス件数（件数上限判定・ボスへ渡す添付件数に使う）。 */
export async function countTaskEvidences(db: Db, taskId: number): Promise<number> {
  const row = await db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM task_evidences WHERE task_id = ?",
    [taskId],
  );
  return row?.count ?? 0;
}

/**
 * 複数タスクのエビデンス件数をまとめて取得する（`task.id` → 件数）。
 * `persona-prompt.ts` の `formatTaskLine` へ渡す `taskEvidenceCounts`
 * （機能仕様 docs/features/completion-evidence-enforcement.md 決定 3-a）を
 * 組み立てる呼び出し元（`chat-messages-route.ts` / `meeting-opening.ts`）が
 * `countTaskEvidences` を1件ずつ呼ぶのを避けるための一括版。件数0件のタスク
 * も含め、渡した全 `taskIds` についてキーを持つ（欠落キーが無い＝呼び出し側
 * が `?? 0` フォールバックを重ねて書かなくてよい）。
 */
export async function countTaskEvidencesByTaskIds(
  db: Db,
  taskIds: number[],
): Promise<Record<number, number>> {
  const counts: Record<number, number> = {};
  for (const taskId of taskIds) {
    counts[taskId] = 0;
  }
  if (taskIds.length === 0) {
    return counts;
  }

  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = await db.all<{ task_id: number; count: number }>(
    `SELECT task_id, COUNT(*) AS count FROM task_evidences
     WHERE task_id IN (${placeholders}) GROUP BY task_id`,
    taskIds,
  );
  for (const row of rows) {
    counts[row.task_id] = row.count;
  }
  return counts;
}

export async function findTaskEvidenceById(
  db: Db,
  id: number,
): Promise<TaskEvidence | undefined> {
  return db.get<TaskEvidence>("SELECT * FROM task_evidences WHERE id = ?", [id]);
}

/**
 * `task_evidences` に 1 行挿入し、読み戻した行を返す。`kind` に応じて
 * 非対象の列（file なら `url`、link なら `stored_filename` /
 * `original_filename` / `mime_type` / `size_bytes`）は NULL で埋める。
 */
export async function insertTaskEvidence(
  db: Db,
  record: NewTaskEvidenceRecord,
): Promise<TaskEvidence> {
  const now = new Date().toISOString();

  const result = await db.run(
    `INSERT INTO task_evidences (
      task_id, kind, stored_filename, original_filename, mime_type, size_bytes, url, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.task_id,
      record.kind,
      record.kind === "file" ? record.stored_filename : null,
      record.kind === "file" ? record.original_filename : null,
      record.kind === "file" ? record.mime_type : null,
      record.kind === "file" ? record.size_bytes : null,
      record.kind === "link" ? record.url : null,
      now,
    ],
  );

  const evidence = await findTaskEvidenceById(db, result.lastInsertRowid);
  if (!evidence) {
    throw new Error("failed to read back the inserted task evidence");
  }
  return evidence;
}

/**
 * `task_evidences` から 1 行削除する。存在しない id は no-op で `false` を
 * 返す（呼び出し元がこれ以上のエラー処理を要らない設計にできる）。
 */
export async function deleteTaskEvidence(db: Db, id: number): Promise<boolean> {
  const result = await db.run("DELETE FROM task_evidences WHERE id = ?", [id]);
  return result.changes > 0;
}
