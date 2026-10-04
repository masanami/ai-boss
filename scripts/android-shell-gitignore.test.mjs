/**
 * Android の器の Gradle のプロジェクト（`native/tauri-app/gen/android`）の追跡と無視の規則
 * （#674 S1・機能仕様 docs/features/android-shell.md 決定 4・受入基準（S1）「`gen/android`」）。
 * `node --test scripts/`（`npm run test:scripts`）で実行する。実際の `git` に問い合わせる。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const genAndroid = "native/tauri-app/gen/android";

function git(...args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

/**
 * `git check-ignore -q` が 0 で終わる（無視の規則に当たる）か。パスは実在しなくてよい。
 * 開発機ごとの全体の除外設定（`core.excludesFile`）は使わず、リポジトリの規則だけで判定する。
 */
function isIgnored(path) {
  const { status } = git("-c", "core.excludesFile=/dev/null", "check-ignore", "-q", "--no-index", path);
  assert.ok(status === 0 || status === 1, `git check-ignore が失敗した（終了コード ${status}）`);
  return status === 0;
}

// 受入基準の build.gradle.kts と、手で加えた設定を残すためにコミットするもの（決定 4 の理由）。
const committedFiles = [
  "app/build.gradle.kts",
  "app/src/main/AndroidManifest.xml",
  "app/src/main/java/dev/aiboss/app/MainActivity.kt",
  "build.gradle.kts",
  "settings.gradle",
  "gradle/wrapper/gradle-wrapper.properties",
].map((file) => `${genAndroid}/${file}`);

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

const ignoredPaths = [
  ["local.properties（開発機の SDK の場所）", "local.properties"],
  ["app/build の下（ビルドの出力）", "app/build/outputs/apk/universal/debug/app-universal-debug.apk"],
  ["buildSrc/build の下（ビルドの出力）", "buildSrc/build/libs/buildSrc.jar"],
  [".gradle の下（Gradle の状態）", ".gradle/9.6.1/checksums/checksums.lock"],
  ["直下の *.jks（署名の鍵）", "upload.jks"],
  ["app の下の *.jks（署名の鍵）", "app/release.jks"],
  ["直下の *.keystore（署名の鍵）", "release.keystore"],
  ["app の下の *.keystore（署名の鍵）", "app/debug.keystore"],
  [".idea の下（Android Studio の開発機ごとの状態）", ".idea/gradle.xml"],
  [".kotlin の下（Kotlin のセッション）", ".kotlin/sessions/x.salive"],
];

for (const [label, file] of ignoredPaths) {
  test(`gen/android の ${label} は無視される`, () => {
    assert.equal(isIgnored(`${genAndroid}/${file}`), true);
  });
}

test("gen/android の追跡されているファイルに、local.properties・*.jks・*.keystore が無い", () => {
  const { status, stdout } = git("ls-files", genAndroid);
  assert.equal(status, 0);
  const files = stdout.split("\n").filter(Boolean);
  assert.ok(files.length > 0, "gen/android がコミットされていない");
  const leaked = files.filter((file) => /(^|\/)local\.properties$|\.jks$|\.keystore$/.test(file));
  assert.deepEqual(leaked, []);
});
