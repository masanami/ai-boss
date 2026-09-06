export const EVIDENCE_KINDS = ["file", "link"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

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

/**
 * 拡張子 → MIME の対応表（機能仕様
 * docs/features/completion-evidence-enforcement.md 決定 1-c）。この表が
 * 拡張子ホワイトリストと MIME 導出の**単一の情報源**である — `mime_type`
 * 列の保存値も、`content` 配信時の `Content-Type`（後続チケット）も、ここ
 * から引く（明示的な仮定 10）。キーは小文字・先頭ドット付き。
 *
 * ここに無い拡張子はすべて拒否される（ホワイトリスト方式）。とくに実行可能
 * 形式（.app/.exe/.sh/.command/.scpt/.bat/.ps1/.jar/.pkg/.dmg）とアクティブ
 * コンテンツ形式（.html/.htm/.svg/.xhtml）は明示的に含めない。`.svg` は
 * 画像だが、同一オリジンからのインライン配信でスクリプトが動きうるため
 * 除外する（オーナー確定事項・明示的な仮定 5）。
 */
export const EVIDENCE_EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * 拡張子ホワイトリスト（決定 1-c）。判定は小文字化して行う。
 * `EVIDENCE_EXTENSION_MIME_TYPES` から導出し、2 つの一覧が食い違わないよう
 * にする（DRY — 単一の情報源はあくまで MIME 対応表そのもの）。
 */
export const ALLOWED_EVIDENCE_EXTENSIONS: readonly string[] = Object.keys(
  EVIDENCE_EXTENSION_MIME_TYPES,
);

export const MAX_EVIDENCE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_EVIDENCES_PER_TASK = 10;
