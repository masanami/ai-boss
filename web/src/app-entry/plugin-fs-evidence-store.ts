import { BaseDirectory, exists, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
import { isValidStoredEvidenceFilename, type EvidenceStore } from "../../../server/src/core-entry.js";

/**
 * 製品版の証跡の保存の実装（plugin-fs。#579 S4・機能仕様
 * docs/features/tauri-in-app-runtime.md「S4 の設計」）。
 *
 * 保存先は `baseDir: BaseDirectory.AppConfig` の相対パス `evidence/<保存名>`
 * （絶対パスを JS で組み立てない。`core:path` の権限も足さない）。Rust 側は
 * capability のスコープ `$APPCONFIG/evidence/*` に当たるパスだけを許可する
 * （`native/tauri-app/capabilities/default.json`）— **境界の本体はそちら**で、
 * ここの保存名の検査は多層防御。
 *
 * 保存名は DB の `stored_filename` から来るが、WebView の JS は SQL を実行できる
 * ため任意の文字列になりうる。コアの保存名生成が作る形（小文字の UUID ＋
 * ホワイトリストの拡張子）でないとき、plugin-fs を呼ばない（仮定 A12）:
 * `write` は拒否し、`read` は「無い」、`remove` は何もしない（`remove` は行の
 * 削除の確定後に呼ばれるため、例外にすると削除の応答だけが 500 になり行は
 * 消えている、という食い違いを作る）。検査を通った保存名での IPC の失敗は、
 * 開発者用の版の Node fs 実装（`writeFileSync`・`unlinkSync`）と同じく握りつぶさず
 * 伝える。`read`・`remove` は `exists` で有無を確かめてから行う（同じく
 * Node fs 実装の `existsSync` に合わせる）。
 */

/**
 * 保存先のディレクトリ名（`app_config_dir` の直下）。Rust の `EVIDENCE_DIR_NAME` と
 * capability のスコープ `$APPCONFIG/evidence/*` と一致していることは、定数の共有ではなく
 * テスト（Rust の AC-S4-1・AC-S4-6、`web/tauri-db/` の AC-S4-25）が確かめる。
 */
const EVIDENCE_DIR_NAME = "evidence";

function evidencePath(storedFilename: string): string {
  return `${EVIDENCE_DIR_NAME}/${storedFilename}`;
}

const APP_CONFIG = { baseDir: BaseDirectory.AppConfig };

export function createPluginFsEvidenceStore(): EvidenceStore {
  return {
    async write(storedFilename, data) {
      if (!isValidStoredEvidenceFilename(storedFilename)) {
        throw new Error(`invalid evidence stored filename: ${JSON.stringify(storedFilename)}`);
      }
      await writeFile(evidencePath(storedFilename), data, APP_CONFIG);
    },
    async read(storedFilename) {
      if (!isValidStoredEvidenceFilename(storedFilename)) {
        return undefined;
      }
      const path = evidencePath(storedFilename);
      if (!(await exists(path, APP_CONFIG))) {
        return undefined;
      }
      // `Uint8Array<ArrayBuffer>` に揃える（`readFile` の型は `ArrayBufferLike` 版）。
      return new Uint8Array(await readFile(path, APP_CONFIG));
    },
    async remove(storedFilename) {
      if (!isValidStoredEvidenceFilename(storedFilename)) {
        return;
      }
      const path = evidencePath(storedFilename);
      if (await exists(path, APP_CONFIG)) {
        await remove(path, APP_CONFIG);
      }
    },
  };
}
