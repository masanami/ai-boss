#!/usr/bin/env node
/**
 * 署名つきの製品版（Tauri アプリ・macOS）の `.app` をビルドする（#581 S3・
 * 機能仕様 docs/features/secure-transport-byok.md クリティカル設計決定 9）。
 *
 *   APPLE_SIGNING_IDENTITY="Apple Development: <名前> (<ID>)" APPLE_TEAM_ID=<チーム ID> \
 *     npm run build:tauri:signed [-- --debug]
 *
 * 任意で APPLE_PROVISIONING_PROFILE=<.provisionprofile のパス>。値はリポジトリに
 * 書かない（entitlements などは native/tauri-app/target/signing/ へ生成する）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSignedBuild } from "./tauri-signing.mjs";

const tauriAppDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "native", "tauri-app");

const status = runSignedBuild(
  process.env,
  { tauriAppDir, extraArgs: process.argv.slice(2) },
  {
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    writeFile: (path, content) => writeFileSync(path, content),
    run: (command, args, cwd) => spawnSync(command, args, { cwd, stdio: "inherit" }).status ?? 1,
    logError: (message) => console.error(`build:tauri:signed: ${message}`),
  },
);
process.exit(status);
