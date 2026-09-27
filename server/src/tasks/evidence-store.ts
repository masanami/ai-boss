import type { Db } from "../db/db-port.js";
import type { TaskEvidence } from "./task-evidence.js";
import { extractExtension, resolveEvidenceMimeType } from "./evidence-validation.js";
import {
  deleteTaskEvidence,
  findTaskEvidenceById,
  insertTaskEvidence,
} from "./task-evidences-repository.js";

/**
 * 証跡ファイルの実体（バイト列）を読み書きするポート（機能仕様
 * docs/features/tauri-in-app-runtime.md「機能全体の設計」・実装計画②）。
 *
 * 実行環境ごとの実装（証跡ファイルの保存）は、コアがポートとして受け取り、
 * エントリが実装を注入する。開発者用の版は `evidence-storage.ts` の
 * `createNodeFsEvidenceStore`（Node `fs`）、製品版は #594 の S4（plugin-fs、
 * 本機能の対象外）が担う。バイト列は Web 標準の型（`Uint8Array`）で受け渡す
 * （`Buffer` は `Uint8Array` の派生型なので、開発者用の版の実装はそのまま
 * 受け取れる）。
 */
// `Uint8Array<ArrayBuffer>`（`ArrayBufferLike` ではなく具体的な `ArrayBuffer`
// を型引数にした形）を明示する — TypeScript 5.7 以降、型引数を省略した
// `Uint8Array` は `Uint8Array<ArrayBufferLike>`（`SharedArrayBuffer` も含む
// 広い型）に解決され、Hono の `c.body()` が要求する `Uint8Array<ArrayBuffer>`
// とは互換にならない（Hono のルート層は `ArrayBuffer` 版の `Uint8Array` を
// 前提にしている）。`new Uint8Array(n)`／`new File([...]).arrayBuffer()` の
// 戻り値・Node の `Buffer` はいずれも実体として `ArrayBuffer` を裏付けに持つ
// ため、この明示は既存の呼び出し元の実際の値と矛盾しない。
export interface EvidenceStore {
  write(storedFilename: string, data: Uint8Array<ArrayBuffer>): void;
  read(storedFilename: string): Uint8Array<ArrayBuffer> | undefined;
  remove(storedFilename: string): void;
}

export interface SaveFileEvidenceInput {
  taskId: number;
  /** アップロード時にクライアントが送ってきた元のファイル名（表示用）。 */
  originalFilename: string;
  data: Uint8Array<ArrayBuffer>;
}

/**
 * サーバ生成のファイル名を作る（決定 1-c-i）。ユーザー由来のファイル名を
 * 保存パスへそのまま使うと `../` を含む名前でパストラバーサルになるため、
 * 保存名はランダムな UUID + 拡張子のみで構成する。`extractExtension` は
 * パス区切りの後ろの最終コンポーネントからしか拡張子を読まないため、
 * `originalFilename` に `/` や `..` が含まれていても、この拡張子部分に
 * それらが混ざることはない（結果として `stored_filename` はスラッシュを
 * 含まない一意な相対名になる。AC-43）。`crypto.randomUUID()` は Web 標準の
 * グローバル（`node:crypto` の値 import ではない）— ブラウザ実行環境でも
 * 解決できる。
 */
function generateStoredFilename(originalFilename: string): string {
  return `${crypto.randomUUID()}${extractExtension(originalFilename).toLowerCase()}`;
}

/**
 * ファイルエビデンスを保存する: `store.write` で実体を書き込んでから
 * `task_evidences` に行を挿入する（この順序が重要 — 挿入を先にすると、
 * 書き込み失敗時に実体の無い行＝孤児行が残る。逆に書き込みを先にすれば、
 * 万一 DB 挿入が失敗しても残るのは無害な孤児ファイルだけで済む）。
 *
 * 拡張子がホワイトリスト外の場合は MIME を導出できないため、書き込む前に
 * エラーを投げる（HTTP 400 としての整形はルート層の責務）。
 */
export async function saveFileEvidence(
  db: Db,
  store: EvidenceStore,
  input: SaveFileEvidenceInput,
): Promise<TaskEvidence> {
  const mimeType = resolveEvidenceMimeType(input.originalFilename);
  if (!mimeType) {
    throw new Error(`evidence extension not allowed: ${input.originalFilename}`);
  }

  const storedFilename = generateStoredFilename(input.originalFilename);
  store.write(storedFilename, input.data);

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

/** リンクエビデンスを保存する。ファイルシステム（`EvidenceStore`）には
 * 一切触れない — DB のみで完結するため、実行環境に依存しない。 */
export async function saveLinkEvidence(
  db: Db,
  input: SaveLinkEvidenceInput,
): Promise<TaskEvidence> {
  return insertTaskEvidence(db, {
    task_id: input.taskId,
    kind: "link",
    url: input.url,
  });
}

/**
 * エビデンスを削除する。DB 行を先に削除してから `store.remove` を呼ぶ
 * （「機能全体の設計」: 逆順だと「行はあるが実体が無い」孤児行が残る。この
 * 順序なら最悪ケースは実体だけが残ることで、参照されないので実害が無い。
 * 孤児ファイルの掃除機構は作らない＝YAGNI）。
 *
 * 存在しない id は no-op で `false` を返す。`kind: "link"` の行を消しても
 * `store.remove` は呼ばない。実体が既に無い `stored_filename` に対する
 * `store.remove` の呼び出しを no-op にする責務は各 `EvidenceStore` 実装が
 * 持つ（`evidence-storage.ts` の Node fs 実装は `unlinkSync` の前に
 * `existsSync` で確認する）。
 */
export async function deleteEvidence(
  db: Db,
  store: EvidenceStore,
  evidenceId: number,
): Promise<boolean> {
  const evidence = await db.transaction((tx) => deleteEvidenceRow(tx, evidenceId));
  if (!evidence) {
    return false;
  }
  removeEvidenceFile(store, evidence);
  return true;
}

/**
 * {@link deleteEvidence} の DB 側だけ: 行を読んで削除し、削除した行を返す
 * （無ければ `undefined`）。呼び出し元のトランザクション（`tx`）の中で、
 * 削除の可否の判定と一緒に使う（E1・#604: `task-evidences-routes.ts` の
 * `DELETE`）。ファイルの実体は消さない — トランザクションの確定後に
 * {@link removeEvidenceFile} を呼ぶ（ファイル操作をトランザクションに
 * 入れない。機能仕様 docs/features/async-db-layer.md 決定 2）。
 */
export async function deleteEvidenceRow(
  db: Db,
  evidenceId: number,
): Promise<TaskEvidence | undefined> {
  const evidence = await findTaskEvidenceById(db, evidenceId);
  if (!evidence) {
    return undefined;
  }
  const deleted = await deleteTaskEvidence(db, evidenceId);
  return deleted ? evidence : undefined;
}

/** 削除済みの行がファイルエビデンスなら、その実体を消す（リンクは何もしない）。 */
export function removeEvidenceFile(store: EvidenceStore, evidence: TaskEvidence): void {
  if (evidence.kind === "file" && evidence.stored_filename) {
    store.remove(evidence.stored_filename);
  }
}
