#!/usr/bin/env node
/**
 * 製品版の器（native/tauri-app/）のライブラリを Android（aarch64-linux-android）向けに
 * `cargo check` する（#674 S1・機能仕様 docs/features/android-shell.md 決定 3）。
 *
 *   npm run check:android
 *
 * 開発機に `rustup target add aarch64-linux-android` と Android NDK が要る。NDK の場所の
 * 探し方は scripts/android-ndk.mjs。
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckAndroid } from "./android-ndk.mjs";

const manifestPath = join(fileURLToPath(new URL(".", import.meta.url)), "..", "native", "tauri-app", "Cargo.toml");

const status = runCheckAndroid(
  process.env,
  { manifestPath },
  {
    homedir: homedir(),
    platform: process.platform,
    isDirectory: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
    listDirectory: (path) => readdirSync(path),
    run: (command, args, env) => {
      const result = spawnSync(command, args, { env, stdio: "inherit" });
      if (result.error) {
        // cargo が PATH に無い等。品質の失敗ではなく準備の不足として理由を出す。
        console.error(`check:android: ${command} を起動できません（${result.error.message}）。Rust のツールチェーンを PATH に入れてください。`);
      }
      return result.status ?? 1;
    },
    logError: (message) => console.error(`check:android: ${message}`),
    logInfo: (message) => console.error(`check:android: ${message}`),
  },
);
process.exit(status);
