import { extname } from "node:path";
import {
  EVIDENCE_EXTENSION_MIME_TYPES,
  MAX_EVIDENCES_PER_TASK,
  MAX_EVIDENCE_FILE_BYTES,
} from "./task-evidence.js";

/**
 * 拡張子を小文字化して取り出す。`node:path` の `extname` はパス区切りより
 * 後ろの最終コンポーネントからのみ拡張子を読むため、`../../etc/passwd.png`
 * のようなパストラバーサルを含むファイル名を渡しても `.png` だけが返る
 * （`stored_filename` はこの値ではなくサーバ生成名から作られるので、この
 * 挙動自体がパストラバーサル対策になっているわけではない。決定 1-c-i の
 * 対策は `evidence-storage.ts` 側にある）。
 */
function lowerExtname(filename: string): string {
  return extname(filename).toLowerCase();
}

/** 拡張子ホワイトリスト判定（決定 1-c）。大文字小文字を区別しない。 */
export function isAllowedEvidenceExtension(filename: string): boolean {
  return lowerExtname(filename) in EVIDENCE_EXTENSION_MIME_TYPES;
}

/**
 * 拡張子から MIME を導出する（決定 1-c-ii: クライアント申告の MIME は使わ
 * ない）。ホワイトリスト外の拡張子は `undefined`。
 */
export function resolveEvidenceMimeType(filename: string): string | undefined {
  return EVIDENCE_EXTENSION_MIME_TYPES[lowerExtname(filename)];
}

/** サイズ上限判定（10 MB、境界含む＝上限ちょうどは許可）。 */
export function isEvidenceFileSizeAllowed(sizeBytes: number): boolean {
  return sizeBytes <= MAX_EVIDENCE_FILE_BYTES;
}

/**
 * 件数上限判定。`currentCount` は追加前の既存件数で、これから 1 件足そうと
 * している場面を表す。上限（10 件）に達している場合は追加できない
 * （境界: ちょうど 10 件で拒否＝ `<` であって `<=` ではない）。
 */
export function isEvidenceCountUnderLimit(currentCount: number): boolean {
  return currentCount < MAX_EVIDENCES_PER_TASK;
}

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

/**
 * URL スキーム判定（`http` / `https` のみ許可）。不正な URL 文字列
 * （`URL` コンストラクタが例外を投げるもの）は例外を投げず `false` を返す。
 */
export function isAllowedEvidenceUrlScheme(url: string): boolean {
  try {
    return ALLOWED_URL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
