import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFsEvidenceStore } from "./evidence-storage.js";
import { describeEvidenceStoreContract } from "./test-support/evidence-store-contract.js";

/**
 * 両版で同じ契約スイートを、開発者用の版（Node fs 実装・一時ディレクトリ）で
 * 回す（#579 S4・機能仕様 docs/features/tauri-in-app-runtime.md 受入基準（S4）
 * AC-S4-26〜29）。製品版（plugin-fs 実装）では同じ本体を
 * `web/tauri-db/`（`npm run test:tauri-db`）が回す。
 */
describeEvidenceStoreContract("Node fs", async () => {
  const root = mkdtempSync(join(tmpdir(), "ai-boss-evidence-contract-"));
  return {
    store: createNodeFsEvidenceStore(join(root, "evidence")),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
});
