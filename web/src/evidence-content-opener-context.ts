import { createContext } from "react";

/**
 * 証跡ファイルの本体を Blob URL 方式で開く関数（機能仕様
 * docs/features/tauri-in-app-runtime.md クリティカル設計決定1・S2「証跡ファイル
 * の <a href>」）。呼ぶと本文を取得し、成功したら新しいウィンドウで開く
 * （失敗したら例外を投げる。呼び出し元がそれを捕まえてエラー表示する）。
 */
export type EvidenceContentOpener = (evidenceContentUrl: string) => Promise<void>;

/**
 * 製品版（Tauri アプリ）のエントリだけがこのコンテキストへ値を注入する
 * （`web/src/app-entry/main.tsx`）。既定値は `null` — 開発者用の版
 * （`npm run start`）は注入しないため、`use-task-evidences.ts` は
 * `useContext` が `null` を返す間、現行どおり `<a href>` の方式を維持する。
 */
export const EvidenceContentOpenerContext = createContext<EvidenceContentOpener | null>(null);

/**
 * 取得には成功したが、応答が `Content-Disposition: attachment`（画像・PDF
 * 以外）のため開かなかったことを表す例外（PR #646 の Codex 指摘 P2）。
 * 製品版の器はダウンロードを拒否しており（機能仕様「やらないこと」S2 追加分:
 * 画像・PDF 以外の証跡は S2 の器では開けない）、`use-task-evidences.ts` は
 * 取得の失敗と区別した文言を `actionError` に出す。
 */
export class EvidenceNotOpenableError extends Error {
  constructor() {
    super("この形式の証跡はアプリ内では開けません（画像・PDF のみ）");
    this.name = "EvidenceNotOpenableError";
  }
}
