/**
 * Mirrors `server/src/tasks/task-evidence.ts` (機能仕様
 * docs/features/completion-evidence-enforcement.md「機能全体の設計」の IF /
 * API 節）。`web/` と `server/` は別 npm workspace で共有パッケージが無いため、
 * 型はここに複製する（`web/src/task.ts` が `server/src/tasks/task.ts` を複製
 * しているのと同じ作法）。
 */
export const EVIDENCE_KINDS = ["file", "link"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** `GET/POST /api/tasks/:id/evidences` のレスポンス表現。DB 列と 1:1。 */
export interface TaskEvidence {
  id: number;
  task_id: number;
  kind: EvidenceKind;
  stored_filename: string | null;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  url: string | null;
  created_at: string;
}
