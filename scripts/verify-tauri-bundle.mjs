#!/usr/bin/env node
/**
 * 生成された macOS の `.app`（`npm run build:tauri` の出力）に、`node` という
 * 名前のファイルと `node_modules` という名前のディレクトリが含まれないことを
 * 検査する（機能仕様 docs/features/tauri-in-app-runtime.md 受入基準（S2）
 * 「開発者用の版と品質ゲート」）。
 *
 * オーナーの決定 Q4-b（Tauri アプリでは `claude-code` を動かさない・
 * サイドカー等で Node を起動する経路を作らない）の構造的な担保 — バンドルに
 * Node 本体や npm 依存が紛れ込んでいないことを固定する。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));

const BUNDLE_DIR = join(
  SCRIPT_DIR,
  "..",
  "native",
  "tauri-app",
  "target",
  "release",
  "bundle",
  "macos",
);

/** @returns {string[]} 見つかった禁止エントリの絶対パス一覧 */
function findForbiddenEntries(root) {
  const forbidden = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      // self-review（code-reviewer, CONFIRMED）: 名前だけで判定する
      // （`isDirectory()`/`isFile()` の種別チェックを付けない）。
      // `readdirSync` はシンボリックリンクを追跡しないため、リンクは
      // `isDirectory()`/`isFile()` のどちらも false（`isSymbolicLink()` が
      // true）になり、種別チェックを付けると「`node` という名前のシンボリック
      // リンク」「`node_modules` という名前のシンボリックリンク」を素通しして
      // しまう。禁止したいのは「その名前のエントリが存在すること」自体（種別は
      // 問わない）。
      if (entry.name === "node_modules") {
        forbidden.push(fullPath);
        continue; // この配下は探索しない（見つけた事実だけで十分。ディレクトリ
        // でなければそもそも配下を持たない）
      }
      if (entry.name === "node") {
        forbidden.push(fullPath);
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
  return forbidden;
}

function findAppBundles(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    console.error(`検査対象のバンドルディレクトリが見つかりません: ${root}`);
    console.error(String(error));
    process.exit(1);
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => join(root, entry.name));
}

const appBundles = findAppBundles(BUNDLE_DIR);
if (appBundles.length === 0) {
  console.error(`.app バンドルが見つかりません: ${BUNDLE_DIR}`);
  console.error("先に npm run build:tauri を実行してください。");
  process.exit(1);
}

let hasForbiddenEntries = false;
for (const appBundle of appBundles) {
  // .app は実体はディレクトリ（statSync で確認するのは自己記録目的。
  // readdirSync が directory 前提で動くため実質必須ではないが、想定外の
  // 入力に対して分かりやすいエラーにするため明示的に確認する）。
  statSync(appBundle);
  const forbidden = findForbiddenEntries(appBundle);
  if (forbidden.length > 0) {
    hasForbiddenEntries = true;
    console.error(`${appBundle} に禁止エントリが見つかりました:`);
    for (const entry of forbidden) {
      console.error(`  - ${entry}`);
    }
  } else {
    console.log(`OK: ${appBundle} に node / node_modules は含まれていません`);
  }
}

if (hasForbiddenEntries) {
  process.exit(1);
}
