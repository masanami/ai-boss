/**
 * Android 向けのコンパイルの検査（`npm run check:android`）の NDK の解決と cargo の呼び出し
 * （#674 S1・機能仕様 docs/features/android-shell.md 決定 3・受入基準（S1）「Android 向けのビルド」）。
 * `node --test scripts/`（`npm run test:scripts`）で実行する。実際の NDK・cargo は使わない。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANDROID_TARGET, androidToolchainEnv, resolveNdkHome, runCheckAndroid } from "./android-ndk.mjs";

const home = "/Users/someone";
const defaultSdk = `${home}/Library/Android/sdk`;

/** `dirs` に挙げたディレクトリ（と、その子の一覧）だけがある、模擬のファイルシステム。 */
function fakeFs(dirs) {
  return {
    isDirectory: (path) => Object.hasOwn(dirs, path),
    listDirectory: (path) => dirs[path] ?? [],
  };
}

test("NDK_HOME が設定されていれば、その場所を使う", () => {
  const fs = fakeFs({ "/opt/ndk/27": [] });
  assert.equal(resolveNdkHome({ NDK_HOME: "/opt/ndk/27", ANDROID_HOME: "/sdk" }, home, fs), "/opt/ndk/27");
});

test("NDK_HOME が設定されていても、その場所が無ければ解決しない（別の NDK へ黙って移らない）", () => {
  const fs = fakeFs({ "/sdk/ndk": ["30.0.1"], "/sdk/ndk/30.0.1": [] });
  assert.equal(resolveNdkHome({ NDK_HOME: "/missing/ndk", ANDROID_HOME: "/sdk" }, home, fs), null);
});

test("NDK_HOME が空のときは、ANDROID_HOME/ndk の最新の版を使う", () => {
  const fs = fakeFs({
    "/sdk/ndk": ["9.0.1", "27.1.12297006", "30.0.16248370", "29.9.1"],
    "/sdk/ndk/30.0.16248370": [],
  });
  assert.equal(resolveNdkHome({ NDK_HOME: "", ANDROID_HOME: "/sdk" }, home, fs), "/sdk/ndk/30.0.16248370");
});

test("版は数として比べる（文字列の比較で 9 を 30 より新しいとしない）", () => {
  const fs = fakeFs({ "/sdk/ndk": ["9.0.1", "30.0.2", "30.0.10"], "/sdk/ndk/30.0.10": [] });
  assert.equal(resolveNdkHome({ ANDROID_HOME: "/sdk" }, home, fs), "/sdk/ndk/30.0.10");
});

test("版の形でない項目（.DS_Store 等）は選ばない", () => {
  const fs = fakeFs({ "/sdk/ndk": [".DS_Store", "99-not-a-version", "27.0.1"], "/sdk/ndk/27.0.1": [] });
  assert.equal(resolveNdkHome({ ANDROID_HOME: "/sdk" }, home, fs), "/sdk/ndk/27.0.1");
});

test("最初の SDK の ndk/ に版が無ければ、次の候補の SDK の NDK を使う", () => {
  const fs = fakeFs({
    "/sdk/ndk": [".DS_Store"],
    [`${defaultSdk}/ndk`]: ["30.0.16248370"],
    [`${defaultSdk}/ndk/30.0.16248370`]: [],
  });
  assert.equal(resolveNdkHome({ ANDROID_HOME: "/sdk" }, home, fs), `${defaultSdk}/ndk/30.0.16248370`);
});

test("版の名前でもディレクトリでない項目は選ばない", () => {
  const fs = fakeFs({ "/sdk/ndk": ["31.0.1", "30.0.1"], "/sdk/ndk/30.0.1": [] });
  assert.equal(resolveNdkHome({ ANDROID_HOME: "/sdk" }, home, fs), "/sdk/ndk/30.0.1");
});

test("ANDROID_HOME が無ければ ANDROID_SDK_ROOT の ndk を使う", () => {
  const fs = fakeFs({ "/root-sdk/ndk": ["28.0.1"], "/root-sdk/ndk/28.0.1": [] });
  assert.equal(resolveNdkHome({ ANDROID_SDK_ROOT: "/root-sdk" }, home, fs), "/root-sdk/ndk/28.0.1");
});

test("環境変数がどれも無ければ、macOS の SDK の既定の場所（~/Library/Android/sdk）の ndk を使う", () => {
  const fs = fakeFs({ [`${defaultSdk}/ndk`]: ["30.0.16248370"], [`${defaultSdk}/ndk/30.0.16248370`]: [] });
  assert.equal(resolveNdkHome({}, home, fs), `${defaultSdk}/ndk/30.0.16248370`);
});

test("どこにも NDK が無ければ解決しない", () => {
  assert.equal(resolveNdkHome({}, home, fakeFs({})), null);
  assert.equal(resolveNdkHome({ ANDROID_HOME: "/sdk" }, home, fakeFs({ "/sdk/ndk": [] })), null);
});

test("ツールチェーンの環境変数は NDK の clang・llvm-ar を aarch64-linux-android（minSdk 24）向けに指す", () => {
  const bin = "/ndk/toolchains/llvm/prebuilt/darwin-x86_64/bin";
  assert.deepEqual(androidToolchainEnv("/ndk", "darwin"), {
    NDK_HOME: "/ndk",
    ANDROID_NDK_HOME: "/ndk",
    CC_aarch64_linux_android: `${bin}/aarch64-linux-android24-clang`,
    CXX_aarch64_linux_android: `${bin}/aarch64-linux-android24-clang++`,
    AR_aarch64_linux_android: `${bin}/llvm-ar`,
    CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: `${bin}/aarch64-linux-android24-clang`,
  });
  assert.equal(
    androidToolchainEnv("/ndk", "linux").CC_aarch64_linux_android,
    "/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang",
  );
});

function fakeDeps(dirs) {
  const record = { runs: [], errors: [], infos: [] };
  const deps = {
    ...fakeFs(dirs),
    homedir: home,
    platform: "darwin",
    run: (command, args, env) => {
      record.runs.push({ command, args, env });
      return 0;
    },
    logError: (message) => record.errors.push(message),
    logInfo: (message) => record.infos.push(message),
  };
  return { deps, record };
}

test("NDK が見つからなければ、cargo を呼ばずに 0 以外で終わり、NDK_HOME を含む案内を出す", () => {
  const { deps, record } = fakeDeps({});
  const status = runCheckAndroid({}, { manifestPath: "/repo/native/tauri-app/Cargo.toml" }, deps);
  assert.notEqual(status, 0);
  assert.deepEqual(record.runs, []);
  assert.match(record.errors.join("\n"), /NDK_HOME/);
});

test("NDK が見つかれば、器のライブラリを aarch64-linux-android で cargo check し、その終了コードを返す", () => {
  const { deps, record } = fakeDeps({ "/sdk/ndk": ["30.0.1"], "/sdk/ndk/30.0.1": [] });
  deps.run = (command, args, env) => {
    record.runs.push({ command, args, env });
    return 101;
  };
  const status = runCheckAndroid(
    { ANDROID_HOME: "/sdk", PATH: "/usr/bin" },
    { manifestPath: "/repo/native/tauri-app/Cargo.toml" },
    deps,
  );
  assert.equal(status, 101);
  assert.equal(record.runs.length, 1);
  const [{ command, args, env }] = record.runs;
  assert.equal(command, "cargo");
  assert.deepEqual(args, ["check", "--manifest-path", "/repo/native/tauri-app/Cargo.toml", "--lib", "--target", ANDROID_TARGET]);
  assert.equal(ANDROID_TARGET, "aarch64-linux-android");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.NDK_HOME, "/sdk/ndk/30.0.1");
  assert.deepEqual(record.infos, ["NDK: /sdk/ndk/30.0.1"]);
  assert.match(env.CC_aarch64_linux_android, /^\/sdk\/ndk\/30\.0\.1\/toolchains\/llvm\/prebuilt\/darwin-x86_64\/bin\//);
});

test("npm run check:android の入口は、NDK が無い環境で 0 以外で終わり、標準エラーに NDK_HOME を含む案内を出す", () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "check-android-"));
  try {
    const script = fileURLToPath(new URL("./check-android.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: emptyHome },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NDK_HOME/);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

const repoFile = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

test("npm の check:android は scripts/check-android.mjs 1 本で、前段で製品版の web をビルドする", () => {
  const { scripts } = JSON.parse(repoFile("package.json"));
  assert.equal(scripts["check:android"], "node scripts/check-android.mjs");
  assert.equal(scripts["precheck:android"], "npm run build:app --workspace web");
});

test("リポジトリの CLAUDE.md の品質方針の必須ゲートに check:android が載っている（決定 Q2）", () => {
  const gate = repoFile("CLAUDE.md")
    .split("\n")
    .find((line) => line.startsWith("- 必須ゲート:"));
  assert.ok(gate, "必須ゲートの行が無い");
  assert.match(gate, /^- 必須ゲート: [^（]*\bcheck:android\b[^（]*の全通過/);
});
