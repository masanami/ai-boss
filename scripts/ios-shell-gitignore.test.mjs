/**
 * iOS の器の Xcode のプロジェクト（`native/tauri-app/gen/apple`）の追跡と無視の規則
 * （#669 S1・機能仕様 docs/features/ios-shell.md 決定 2・受入基準（S1）「`gen/apple`」）。
 * `node --test scripts/`（`npm run test:scripts`）で実行する。実際の `git` に問い合わせる。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const genApple = "native/tauri-app/gen/apple";

function git(...args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

/** `git check-ignore -q` が 0 で終わる（無視の規則に当たる）か。パスは実在しなくてよい。 */
function isIgnored(path) {
  const { status } = git("check-ignore", "-q", "--no-index", path);
  assert.ok(status === 0 || status === 1, `git check-ignore が失敗した（終了コード ${status}）`);
  return status === 0;
}

// project.yml（受入基準）と、手で加えた設定を残すためにコミットする Info.plist・
// エンタイトルメント・Xcode のプロジェクト（決定 2 の理由）。
const committedFiles = [
  "project.yml",
  "ai-boss-tauri-app_iOS/Info.plist",
  "ai-boss-tauri-app_iOS/ai-boss-tauri-app_iOS.entitlements",
  "ai-boss-tauri-app.xcodeproj/project.pbxproj",
  "Assets.xcassets/AppIcon.appiconset/Contents.json",
].map((file) => `${genApple}/${file}`);

for (const path of committedFiles) {
  test(`${path} はコミットされている`, () => {
    const { status, stdout } = git("ls-files", path);
    assert.equal(status, 0);
    assert.deepEqual(stdout.split("\n").filter(Boolean), [path]);
  });

  test(`${path} は無視の規則に当たらない`, () => {
    assert.equal(isIgnored(path), false);
  });
}

test("gen/schemas の下は無視される（tauri-build の生成物）", () => {
  assert.equal(isIgnored("native/tauri-app/gen/schemas/acl-manifests.json"), true);
});

test("gen/apple/build の下は無視される（iOS のビルドの出力）", () => {
  assert.equal(isIgnored(`${genApple}/build/arm64-sim/ai-boss.app/Info.plist`), true);
});

test("gen/apple/Externals の下は無視される（Rust の静的ライブラリの写し）", () => {
  assert.equal(isIgnored(`${genApple}/Externals/arm64/release/libapp.a`), true);
});

test("通知プラグインの fork の .tauri の下は無視される（iOS のビルドで写される tauri-api）", () => {
  assert.equal(isIgnored("native/tauri-plugin-notification/.tauri/tauri-api/Package.swift"), true);
});
