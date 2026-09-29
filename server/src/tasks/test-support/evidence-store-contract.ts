import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_EVIDENCE_EXTENSIONS } from "../task-evidence.js";
import type { EvidenceStore } from "../evidence-store.js";

/**
 * 両版で同じ契約スイート（#579 S4・機能仕様
 * docs/features/tauri-in-app-runtime.md 受入基準（S4）AC-S4-26〜29）。
 *
 * テスト専用の補助。実装に依存しない — 呼び出し側が「空の保存先の上の
 * `EvidenceStore`」を開く関数を渡す:
 * - 開発者用の版: Node fs 実装（一時ディレクトリ）。`evidence-store-contract.test.ts`
 *   （`npm test`）
 * - 製品版: plugin-fs 実装（`@tauri-apps/plugin-fs` → 器の IPC の中継 → Rust の
 *   plugin-fs と capability のスコープ）。`web/tauri-db/`（`npm run test:tauri-db`）
 *
 * 保存名は、コアが作る形（小文字の UUID ＋ ホワイトリストの拡張子）にする。
 */

export interface EvidenceStoreContractSubject {
  /** 空の保存先の上の証跡の保存ポート */
  store: EvidenceStore;
  /** テストの後始末（子プロセス・一時ディレクトリを閉じる） */
  close(): Promise<void> | void;
}

/** コアの保存名生成が作る形の保存名を 1 つ作る。 */
export function newStoredFilename(extension = ".png"): string {
  if (!ALLOWED_EVIDENCE_EXTENSIONS.includes(extension)) {
    throw new Error(`not a whitelisted evidence extension: ${extension}`);
  }
  return `${crypto.randomUUID()}${extension}`;
}

/** 0 から 255 を繰り返す決定的なバイト列（全バイト値を含む）。 */
function patternBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = i % 256;
  }
  return bytes;
}

const ONE_MEGABYTE = 1024 * 1024;

/**
 * バイト列の内容が同じことを確かめる。Node fs 実装の `read` は `Buffer`（
 * `Uint8Array` の派生型）を返すため、`toEqual` の型の比較は使わず、長さと
 * 最初に食い違うバイトの位置で比べる（1 MB でも遅くならない）。
 */
function expectSameBytes(actual: Uint8Array | undefined, expected: Uint8Array): void {
  expect(actual).toBeDefined();
  const bytes = actual as Uint8Array;
  expect(bytes.length).toBe(expected.length);
  let firstMismatch = -1;
  for (let i = 0; i < expected.length; i++) {
    if (bytes[i] !== expected[i]) {
      firstMismatch = i;
      break;
    }
  }
  expect(firstMismatch).toBe(-1);
}

export function describeEvidenceStoreContract(
  name: string,
  open: () => Promise<EvidenceStoreContractSubject>,
): void {
  describe(`EvidenceStore の契約: ${name}`, () => {
    let subject: EvidenceStoreContractSubject | undefined;

    beforeEach(async () => {
      subject = undefined;
      subject = await open();
    });

    afterEach(async () => {
      await subject?.close();
    });

    function store(): EvidenceStore {
      if (!subject) {
        throw new Error("the subject was not opened");
      }
      return subject.store;
    }

    it("AC-S4-26: write したバイト列は read で同じバイト列に戻る（全バイト値）", async () => {
      const storedFilename = newStoredFilename();
      const data = patternBytes(1024);

      await store().write(storedFilename, data);

      expectSameBytes(await store().read(storedFilename), data);
    });

    it("AC-S4-26: 0 バイトのファイルも write して read で戻る（有るが空、は「無い」と区別される）", async () => {
      const storedFilename = newStoredFilename(".txt");

      await store().write(storedFilename, new Uint8Array(0));

      const read = await store().read(storedFilename);
      expect(read).toBeDefined();
      expect(read?.length).toBe(0);
    });

    it("AC-S4-26: 1 MB のバイト列も write して read で同じバイト列に戻る", async () => {
      const storedFilename = newStoredFilename(".pdf");
      const data = patternBytes(ONE_MEGABYTE);

      await store().write(storedFilename, data);

      expectSameBytes(await store().read(storedFilename), data);
    });

    it("AC-S4-26: 同じ保存名への 2 回目の write は内容を置き換える", async () => {
      const storedFilename = newStoredFilename();

      await store().write(storedFilename, new Uint8Array([1, 2, 3, 4]));
      await store().write(storedFilename, new Uint8Array([9]));

      expectSameBytes(await store().read(storedFilename), new Uint8Array([9]));
    });

    it("AC-S4-27: 書いていない保存名の read は undefined を返す", async () => {
      expect(await store().read(newStoredFilename())).toBeUndefined();
    });

    it("AC-S4-28: remove した保存名の read は undefined を返す", async () => {
      const storedFilename = newStoredFilename();
      await store().write(storedFilename, new Uint8Array([1]));

      await store().remove(storedFilename);

      expect(await store().read(storedFilename)).toBeUndefined();
    });

    it("AC-S4-28: remove は、ほかの保存名のファイルを消さない", async () => {
      const removed = newStoredFilename();
      const kept = newStoredFilename(".jpg");
      await store().write(removed, new Uint8Array([1]));
      await store().write(kept, new Uint8Array([2]));

      await store().remove(removed);

      expectSameBytes(await store().read(kept), new Uint8Array([2]));
    });

    it("AC-S4-29: 書いていない保存名の remove は失敗しない", async () => {
      await expect(Promise.resolve(store().remove(newStoredFilename()))).resolves.toBeUndefined();
    });
  });
}
