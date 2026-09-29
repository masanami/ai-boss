import {
  EVIDENCE_EXTENSION_MIME_TYPES,
  MAX_EVIDENCES_PER_TASK,
  MAX_EVIDENCE_FILE_BYTES,
} from "./task-evidence.js";

/**
 * `node:path` の `extname` 相当の自前実装（機能仕様
 * docs/features/tauri-in-app-runtime.md「機能全体の設計」: `node:path` は
 * ブラウザ実行環境で解決できないため、コア到達可能なこのモジュールでは
 * 使わない。`tasks/evidence-store.ts` の保存名生成もこの関数を使う —
 * 単一ソース）。
 *
 * 意味論は `node:path`（POSIX 版）の `extname` に合わせる: パス区切りは
 * `/` のみとする（`\` は区切りとして扱わない）。**ただし厳密に同一ではない**
 * （PR #598 レビューで実測）: 末尾が `/` の名前（`"x.png/"`）は `extname` が
 * 末尾の区切りを無視して `.png` を返すのに対し、この関数は空文字を返す。
 * `".."` は `extname` が空文字、この関数は `"."` を返す。どちらもホワイト
 * リストに当たらない値になるため、判定は以前より厳しくなる方向にしか
 * ずれない（許可されていた名前が拒否されうるだけで、拒否されていた名前が
 * 許可されることはない）。ブラウザから届くファイル名（`File.name`）は
 * パスを含まないため、実用上この差に当たることはない。CLAUDE.md の前提
 * 「macOS ローカル完結」の下で元のコードが実際に使っていたのは常に
 * POSIX 版の `path.extname`（`node:path` は macOS では POSIX 実装を
 * 指す）であり、それは `\` をパス区切りとして扱わない（Windows 版
 * `path.win32.extname` とは異なる — self-review: code-reviewer の指摘
 * 「`\` も区切りに含めると、元の実装より*厳しい*方向に振る舞いが変わる」
 * を受けて、`\` の特別扱いをやめた）。最終コンポーネント（`/` 区切りの
 * 最後の部分）の、最後の `.` 以降を拡張子とする。先頭ドットのみ（隠し
 * ファイル名など、そのコンポーネント内に `.` が先頭にしか無い場合）は
 * 拡張子なし（空文字）として扱う。
 */
export function extractExtension(filename: string): string {
  const lastComponent = filename.split("/").pop() ?? filename;
  const lastDotIndex = lastComponent.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return "";
  }
  return lastComponent.slice(lastDotIndex);
}

/**
 * 拡張子を小文字化して取り出す。`../../etc/passwd.png` のようなパス
 * トラバーサルを含むファイル名を渡しても `.png` だけが返る（`stored_filename`
 * はこの値ではなくサーバ生成名から作られるので、この挙動自体がパス
 * トラバーサル対策になっているわけではない。決定 1-c-i の対策は
 * `evidence-storage.ts`／`evidence-store.ts` 側にある）。
 */
function lowerExtname(filename: string): string {
  return extractExtension(filename).toLowerCase();
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

/** 小文字の UUID（`crypto.randomUUID()` の書式。8-4-4-4-12 の 36 文字）。 */
const LOWERCASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_LENGTH = 36;

/**
 * 保存名（`task_evidences.stored_filename`）が、コアの保存名生成
 * （`evidence-store.ts` の `generateStoredFilename`）が作る形 —
 * **小文字の UUID ＋ ホワイトリストの拡張子（小文字）** — かどうかを判定する
 * （#579 S4・機能仕様 docs/features/tauri-in-app-runtime.md「S4 の設計」）。
 *
 * 製品版の plugin-fs 実装が、保存名をパスに使う前に呼ぶ多層防御。保存名は DB
 * から来るが、WebView の JS は SQL を実行できるため任意の文字列になりうる。
 * 境界の本体は Rust 側の capability のスコープで、これはそれに先立って `..`・
 * 区切り文字・想定外の拡張子を通さない。
 */
export function isValidStoredEvidenceFilename(storedFilename: string): boolean {
  if (storedFilename.length <= UUID_LENGTH) {
    return false;
  }
  return (
    LOWERCASE_UUID_PATTERN.test(storedFilename.slice(0, UUID_LENGTH)) &&
    Object.hasOwn(EVIDENCE_EXTENSION_MIME_TYPES, storedFilename.slice(UUID_LENGTH))
  );
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
