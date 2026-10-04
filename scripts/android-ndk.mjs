/**
 * Android 向けのコンパイルの検査（`npm run check:android`）の組み立て（#674 S1・
 * 機能仕様 docs/features/android-shell.md 決定 3・仮定 H5）。
 *
 * `cargo check` でも依存の `build.rs`（ring・libsqlite3-sys 等）が C のコードを NDK の clang で
 * コンパイルするため、NDK の場所からツールチェーンの環境変数を組んで cargo を呼ぶ。
 * NDK の場所は次の順に探す（最初に見つかったもの）:
 *
 * 1. `NDK_HOME`（設定されていれば、その場所だけを使う。無ければ失敗にする）
 * 2. `ANDROID_HOME`・`ANDROID_SDK_ROOT`・macOS の SDK の既定の場所（`~/Library/Android/sdk`）
 *    の順に、NDK の版がある最初の SDK の `ndk/` の下の最新の版
 *
 * 使った NDK の場所は標準エラーに出す（`tauri android build` は `NDK_HOME` にだけ従うため、
 * 手動のビルドでも同じ NDK を `NDK_HOME` に指定できるように）。
 *
 * 2 の後退は、シェルの設定（`~/.zshrc`）を読まない実行（品質ゲートの runner 等）でも、
 * Android Studio の既定の場所に入れた NDK で検査を通すため。
 */
import { join } from "node:path";

/** 検査するターゲット（仮定 H3: Apple Silicon のエミュレータと今の実機の大半）。 */
export const ANDROID_TARGET = "aarch64-linux-android";

/** clang の接頭辞の API レベル（gen/android と通知プラグインの minSdk）。 */
const MIN_SDK = 24;

const VERSION = /^\d+(\.\d+)*$/;

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * NDK の場所を返す。見つからなければ `null`。
 * @param {Record<string, string | undefined>} env
 * @param {string} homedir
 * @param {{ isDirectory: (path: string) => boolean, listDirectory: (path: string) => string[] }} fs
 */
export function resolveNdkHome(env, homedir, fs) {
  if (env.NDK_HOME) {
    return fs.isDirectory(env.NDK_HOME) ? env.NDK_HOME : null;
  }
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(homedir, "Library", "Android", "sdk")]) {
    if (!sdk) continue;
    const ndkDir = join(sdk, "ndk");
    if (!fs.isDirectory(ndkDir)) continue;
    // 版の形の項目が無い（NDK を消した後の空の ndk/ 等）ときは、次の候補の SDK を探す。
    const latest = fs
      .listDirectory(ndkDir)
      .filter((name) => VERSION.test(name) && fs.isDirectory(join(ndkDir, name)))
      .sort((a, b) => compareVersions(b, a))[0];
    if (latest) return join(ndkDir, latest);
  }
  return null;
}

/**
 * NDK のツールチェーンを `aarch64-linux-android` 向けに指す環境変数。
 * NDK の LLVM は macOS では `darwin-x86_64` だけが同梱される（Apple Silicon でも同じ名前）。
 * @param {string} ndkHome
 * @param {NodeJS.Platform} platform
 */
export function androidToolchainEnv(ndkHome, platform) {
  const hostTag = platform === "darwin" ? "darwin-x86_64" : `${platform}-x86_64`;
  const bin = join(ndkHome, "toolchains", "llvm", "prebuilt", hostTag, "bin");
  const clang = join(bin, `${ANDROID_TARGET}${MIN_SDK}-clang`);
  return {
    NDK_HOME: ndkHome,
    ANDROID_NDK_HOME: ndkHome,
    CC_aarch64_linux_android: clang,
    CXX_aarch64_linux_android: `${clang}++`,
    AR_aarch64_linux_android: join(bin, "llvm-ar"),
    CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: clang,
  };
}

/**
 * NDK を解決して器のライブラリを `cargo check` する。終了コードを返す。
 * @param {Record<string, string | undefined>} env
 * @param {{ manifestPath: string }} options
 * @param {{
 *   homedir: string,
 *   platform: NodeJS.Platform,
 *   isDirectory: (path: string) => boolean,
 *   listDirectory: (path: string) => string[],
 *   run: (command: string, args: string[], env: Record<string, string | undefined>) => number,
 *   logError: (message: string) => void,
 *   logInfo?: (message: string) => void,
 * }} deps
 */
export function runCheckAndroid(env, { manifestPath }, deps) {
  const ndkHome = resolveNdkHome(env, deps.homedir, deps);
  if (!ndkHome) {
    deps.logError(
      env.NDK_HOME
        ? `NDK_HOME（${env.NDK_HOME}）に Android NDK がありません。NDK_HOME を NDK の場所（例: $ANDROID_HOME/ndk/<版>）に設定してください。`
        : "Android NDK が見つかりません。NDK_HOME を NDK の場所（例: $ANDROID_HOME/ndk/<版>）に設定してください" +
            "（ANDROID_HOME・ANDROID_SDK_ROOT・~/Library/Android/sdk の ndk/ も探しました）。" +
            "これは品質の失敗ではなく開発機の準備の不足です（docs/features/android-shell.md「手動の確認手順（S1）」の準備）。",
    );
    return 1;
  }
  deps.logInfo?.(`NDK: ${ndkHome}`);
  const args = ["check", "--manifest-path", manifestPath, "--lib", "--target", ANDROID_TARGET];
  return deps.run("cargo", args, { ...env, ...androidToolchainEnv(ndkHome, deps.platform) });
}
