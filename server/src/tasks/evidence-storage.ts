import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type Database from "better-sqlite3";
import type { TaskEvidence } from "./task-evidence.js";
import { resolveEvidenceMimeType } from "./evidence-validation.js";
import {
  deleteTaskEvidence,
  findTaskEvidenceById,
  insertTaskEvidence,
} from "./task-evidences-repository.js";

/**
 * 保管ディレクトリと DB の整合をこのモジュールに閉じる（機能仕様
 * docs/features/completion-evidence-enforcement.md「機能全体の設計」）。
 * ファイル書き込み・削除と DB 行の挿入・削除を必ず組で行い、呼び出し元
 * （後続チケットの API 層）はこのモジュールの関数だけを呼べばよい。
 */

export interface SaveFileEvidenceInput {
  taskId: number;
  /** アップロード時にクライアントが送ってきた元のファイル名（表示用）。 */
  originalFilename: string;
  data: Buffer;
}

/**
 * サーバ生成のファイル名を作る（決定 1-c-i）。ユーザー由来のファイル名を
 * 保存パスへそのまま使うと `../` を含む名前でパストラバーサルになるため、
 * 保存名は `randomUUID()` + 拡張子のみで構成する。`extname` はパス区切りの
 * 後ろの最終コンポーネントからしか拡張子を読まないため、
 * `originalFilename` に `/` や `..` が含まれていても、この拡張子部分に
 * それらが混ざることはない（結果として `stored_filename` はスラッシュを
 * 含まない一意な相対名になる。AC-43）。
 */
function generateStoredFilename(originalFilename: string): string {
  return `${randomUUID()}${extname(originalFilename).toLowerCase()}`;
}

/**
 * ファイルエビデンスを保存する: 保管ディレクトリへ実体を書き込んでから
 * `task_evidences` に行を挿入する（この順序が重要 — 挿入を先にすると、
 * 書き込み失敗時に実体の無い行＝孤児行が残る。逆に書き込みを先にすれば、
 * 万一 DB 挿入が失敗しても残るのは無害な孤児ファイルだけで済む。
 * `deleteEvidence` の順序〔行を先に消す〕と対になる設計）。
 *
 * 拡張子がホワイトリスト外の場合は MIME を導出できないため、書き込む前に
 * エラーを投げる（HTTP 400 としての整形は後続 API チケットの責務）。
 */
export function saveFileEvidence(
  db: Database.Database,
  evidenceDir: string,
  input: SaveFileEvidenceInput,
): TaskEvidence {
  const mimeType = resolveEvidenceMimeType(input.originalFilename);
  if (!mimeType) {
    throw new Error(
      `evidence extension not allowed: ${input.originalFilename}`,
    );
  }

  const storedFilename = generateStoredFilename(input.originalFilename);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, storedFilename), input.data);

  return insertTaskEvidence(db, {
    task_id: input.taskId,
    kind: "file",
    stored_filename: storedFilename,
    original_filename: input.originalFilename,
    mime_type: mimeType,
    size_bytes: input.data.length,
  });
}

export interface SaveLinkEvidenceInput {
  taskId: number;
  url: string;
}

/** リンクエビデンスを保存する。ファイルシステムには一切触れない。 */
export function saveLinkEvidence(
  db: Database.Database,
  input: SaveLinkEvidenceInput,
): TaskEvidence {
  return insertTaskEvidence(db, {
    task_id: input.taskId,
    kind: "link",
    url: input.url,
  });
}

/**
 * エビデンスを削除する。DB 行を先に削除してからファイルを消す
 * （機能仕様「機能全体の設計」: 逆順だと「行はあるが実体が無い」孤児行が
 * 残る。この順序なら最悪ケースは実体だけが残ることで、参照されないので
 * 実害が無い。孤児ファイルの掃除機構は作らない＝YAGNI）。
 *
 * 存在しない id は no-op で `false` を返す。`kind: "link"` の行や、
 * `stored_filename` の実体が既に無い行を消してもエラーにはしない
 * （`unlinkSync` の前に `existsSync` で確認する）。
 */
export function deleteEvidence(
  db: Database.Database,
  evidenceDir: string,
  evidenceId: number,
): boolean {
  const evidence = findTaskEvidenceById(db, evidenceId);
  if (!evidence) {
    return false;
  }

  const deleted = deleteTaskEvidence(db, evidenceId);
  if (!deleted) {
    return false;
  }

  if (evidence.kind === "file" && evidence.stored_filename) {
    const filePath = join(evidenceDir, evidence.stored_filename);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  return true;
}
