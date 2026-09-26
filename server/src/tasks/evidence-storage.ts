import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { TaskEvidence } from "./task-evidence.js";
import {
  saveFileEvidence as saveFileEvidenceCore,
  saveLinkEvidence as saveLinkEvidenceCore,
  deleteEvidence as deleteEvidenceCore,
  type EvidenceStore,
  type SaveFileEvidenceInput,
  type SaveLinkEvidenceInput,
} from "./evidence-store.js";

/**
 * 開発者用の版（現行の Node サーバー版）向けの `EvidenceStore` アダプタと、
 * 既存の呼び出し口（`saveFileEvidence`/`saveLinkEvidence`/`deleteEvidence`）
 * を維持する薄いラッパー（機能仕様
 * docs/features/tauri-in-app-runtime.md「機能全体の設計」・実装計画②）。
 *
 * 保存・削除の実処理（DB 行との整合、保存名生成）は `evidence-store.ts`
 * （実行環境非依存のコア）へ移した。このモジュールは Node `fs`/`path` を使う
 * 側だけを持ち、`tasks/task-evidences-routes.ts`（コア）からは直接 import
 * されない — `app.ts`（開発者用の版の合成ルート）が
 * `createNodeFsEvidenceStore` を呼んで作った `EvidenceStore` を渡す。
 *
 * `saveFileEvidence`/`saveLinkEvidence`/`deleteEvidence` は本番の呼び出し
 * 元を持たない（`app.ts` は `createNodeFsEvidenceStore` だけを使う）— この
 * 3つは `evidence-storage.test.ts`（AC13: 証跡ファイルの保存・読み出し・
 * 削除の既存テストを変更なしで合格させる）との互換のためだけに残した薄い
 * 委譲先である（self-review: code-reviewer が「本番未使用のラッパー」と
 * 指摘・確認済み）。`SaveFileEvidenceInput`/`SaveLinkEvidenceInput` も
 * `evidence-store.ts` から re-export するだけで、ここでは再定義しない
 * （二重定義は self-review で CONFIRMED — 追加フィールドが片方だけに
 * 入っても型検査を通ってしまう）。
 */
export type { SaveFileEvidenceInput };

/** `evidenceDir` 配下にファイルを読み書きする `EvidenceStore` を作る。 */
export function createNodeFsEvidenceStore(evidenceDir: string): EvidenceStore {
  return {
    write(storedFilename, data) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, storedFilename), data);
    },
    read(storedFilename) {
      const filePath = join(evidenceDir, storedFilename);
      if (!existsSync(filePath)) {
        return undefined;
      }
      return readFileSync(filePath);
    },
    remove(storedFilename) {
      const filePath = join(evidenceDir, storedFilename);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    },
  };
}

export function saveFileEvidence(
  db: Database.Database,
  evidenceDir: string,
  input: SaveFileEvidenceInput,
): TaskEvidence {
  return saveFileEvidenceCore(db, createNodeFsEvidenceStore(evidenceDir), input);
}

export function saveLinkEvidence(db: Database.Database, input: SaveLinkEvidenceInput): TaskEvidence {
  return saveLinkEvidenceCore(db, input);
}

export function deleteEvidence(
  db: Database.Database,
  evidenceDir: string,
  evidenceId: number,
): boolean {
  return deleteEvidenceCore(db, createNodeFsEvidenceStore(evidenceDir), evidenceId);
}
