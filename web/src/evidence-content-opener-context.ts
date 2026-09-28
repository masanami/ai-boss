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
