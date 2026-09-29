// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import type { RollupOutput, OutputChunk } from "rollup";
import productConfig from "../../vite.app.config";
import devConfig from "../../vite.config";

/**
 * 受入基準（S2）「製品版に開発者用の経路が混入しないこと（ビルドの検査）」
 * を固定するテスト（機能仕様 docs/features/tauri-in-app-runtime.md S2
 * 「製品版に開発者用の経路が混入しないことの検査（決定3の延長）」）。
 *
 * S1 の `core-entry.bundle.test.ts`（esbuild のメタファイル）に相当する検査
 * を、S2 では製品版の web の実ビルド（Vite）に対して行う。`build()` を
 * `write: false` で呼び、返る Rollup 出力の各チャンクの `moduleIds` の
 * 和集合を「入力モジュール集合」として検査する。
 *
 * 実際にアプリ全体（React・hono 等）をトランスパイル・バンドルするため、
 * 既定の 5 秒タイムアウトでは不足する場合がある — 各テストに長めの
 * タイムアウトを明示する。
 */

function moduleIdsOf(result: RollupOutput): string[] {
  const ids = new Set<string>();
  for (const item of result.output) {
    if (item.type === "chunk") {
      for (const id of (item as OutputChunk).moduleIds) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

function includesAnyInput(ids: string[], substring: string): boolean {
  return ids.some((id) => id.includes(substring));
}

const BUILD_TIMEOUT_MS = 120_000;

let productModuleIds: string[];
let devModuleIds: string[];

beforeAll(async () => {
  const productResult = (await build({
    ...productConfig,
    configFile: false,
    logLevel: "silent",
    build: {
      ...productConfig.build,
      write: false,
      emptyOutDir: false,
    },
  })) as RollupOutput;
  productModuleIds = moduleIdsOf(productResult);

  const devResult = (await build({
    ...devConfig,
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      emptyOutDir: false,
    },
  })) as RollupOutput;
  devModuleIds = moduleIdsOf(devResult);
}, BUILD_TIMEOUT_MS);

describe("製品版の web のビルド（vite.app.config.ts）の入力モジュール", () => {
  it(
    "includes server/src/core-app.ts (コアがアプリ内に載る)",
    () => {
      expect(includesAnyInput(productModuleIds, "server/src/core-app.ts")).toBe(true);
    },
    BUILD_TIMEOUT_MS,
  );

  // #580 S2（docs/features/async-db-layer.md AC-S2-26）: 製品版の DB 実装
  // （plugin-sql・S1 の直列化層・migrate.ts）がアプリ内に載る。
  it.each([
    "@tauri-apps/plugin-sql",
    "web/src/app-entry/plugin-sql-driver.ts",
    "server/src/db/serialized-db.ts",
    "server/src/db/migrate.ts",
  ])(
    "includes %s (製品版の DB 実装)",
    (substring) => {
      expect(includesAnyInput(productModuleIds, substring)).toBe(true);
    },
    BUILD_TIMEOUT_MS,
  );

  // #579 S4（docs/features/tauri-in-app-runtime.md AC-S4-33）: 製品版の証跡の
  // 保存の実装（plugin-fs）がアプリ内に載る。
  it.each(["@tauri-apps/plugin-fs", "web/src/app-entry/plugin-fs-evidence-store.ts"])(
    "includes %s (製品版の証跡の保存)",
    (substring) => {
      expect(includesAnyInput(productModuleIds, substring)).toBe(true);
    },
    BUILD_TIMEOUT_MS,
  );

  it.each([
    // #579 S4（AC-S4-32）: 開発者用の版の Node fs 実装が製品版に載らない。
    "server/src/tasks/evidence-storage.ts",
    "@anthropic-ai/claude-agent-sdk",
    "server/src/llm/backends/claude-code-backend.ts",
    "@anthropic-ai/sdk",
    "@hono/node-server",
    "better-sqlite3",
    "server/src/db/connection.ts",
    "server/src/app.ts",
    "server/src/index.ts",
    "server/src/llm/dev-llm-backends.ts",
  ])(
    "does not include %s",
    (substring) => {
      expect(includesAnyInput(productModuleIds, substring)).toBe(false);
    },
    BUILD_TIMEOUT_MS,
  );
});

describe("開発者用の web のビルド（vite.config.ts / index.html）の入力モジュール", () => {
  it(
    "does not include any server/src/ module",
    () => {
      expect(includesAnyInput(devModuleIds, "server/src/")).toBe(false);
    },
    BUILD_TIMEOUT_MS,
  );
});
