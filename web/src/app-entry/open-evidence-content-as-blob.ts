import { EvidenceNotOpenableError } from "../evidence-content-opener-context.js";
import type { EvidenceContentOpener } from "../evidence-content-opener-context.js";

/**
 * Blob URL の失効までの時間（仮定 A6・機能仕様
 * docs/features/tauri-in-app-runtime.md）。新しいウィンドウが本文を読み終える
 * のに十分で、開きっぱなしの URL を残さない長さ。
 */
export const BLOB_URL_REVOKE_DELAY_MS = 60_000;

/**
 * 応答の `Content-Disposition` の種別が `inline` かどうか（PR #646 の Codex
 * 指摘 P2）。`inline` か `attachment` かは `task-evidences-routes.ts` の
 * `isInlineMimeType`（画像・PDF のみ `inline`）が決めており、その判定を正と
 * してここでは複製しない。Blob に変換すると応答ヘッダは失われるため、変換の
 * 前に見る。ヘッダが無い・解釈できないときは安全側（開かない）に倒す。
 */
function isInlineDisposition(response: Response): boolean {
  const disposition = response.headers.get("Content-Disposition");
  if (disposition === null) {
    return false;
  }
  return disposition.split(";")[0].trim().toLowerCase() === "inline";
}

/**
 * `createBlobEvidenceContentOpener` の依存（機能仕様 S2「証跡ファイルの
 * <a href>」）。テストで `fetch`/`URL.createObjectURL`/`URL.revokeObjectURL`/
 * `window.open`/`setTimeout` をすべてスタブできるよう、注入できる形にする
 * （デフォルト値は持たない — 呼び出し元〔製品版のエントリ〕が実体を渡す）。
 */
export interface BlobEvidenceOpenerDeps {
  fetch: typeof fetch;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  openWindow: (url: string) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
}

/**
 * 証跡ファイルの本体を Blob URL で開く関数を組み立てる（機能仕様
 * クリティカル設計決定1・S2「証跡ファイルの <a href>」）。
 *
 * 本文を `deps.fetch(url)` で取得し、2xx なら `URL.createObjectURL` した
 * `blob:` URL を新しいウィンドウで開き、{@link BLOB_URL_REVOKE_DELAY_MS} 後に
 * 失効させる。2xx 以外なら新しいウィンドウを開かずに例外を投げる（呼び出し元
 * `use-task-evidences.ts` がこれを捕まえて `actionError` に表示する）。
 *
 * 2xx でも `Content-Disposition` が `inline` でない（画像・PDF 以外）なら、
 * Blob を作らず新しいウィンドウも開かずに {@link EvidenceNotOpenableError} を
 * 投げる。`blob:` で開くとテキスト等は添付の方針に反して表示され、Office 等の
 * 型は新しいウィンドウでダウンロードを始めうる（その WebView にはメイン
 * ウィンドウの `on_download` の拒否が掛からない）ため。
 */
export function createBlobEvidenceContentOpener(
  deps: BlobEvidenceOpenerDeps,
): EvidenceContentOpener {
  return async function openEvidenceContentAsBlob(url: string): Promise<void> {
    const response = await deps.fetch(url);
    if (!response.ok) {
      throw new Error(`証跡の取得に失敗しました（status ${response.status}）`);
    }
    if (!isInlineDisposition(response)) {
      throw new EvidenceNotOpenableError();
    }
    const blob = await response.blob();
    const blobUrl = deps.createObjectURL(blob);
    deps.openWindow(blobUrl);
    deps.setTimeout(() => deps.revokeObjectURL(blobUrl), BLOB_URL_REVOKE_DELAY_MS);
  };
}
