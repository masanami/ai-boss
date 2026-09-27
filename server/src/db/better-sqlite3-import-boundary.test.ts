import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// #597 AC-1（機能仕様 docs/features/async-db-layer.md「受入基準（S1）」）:
// 製品コード（`*.test.ts` とテスト専用の補助モジュール〔`test-support/`〕を
// 除く）で `better-sqlite3` を import する（型としての import を含む）のは、
// better-sqlite3 実装のモジュール `db/connection.ts` だけである。

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BETTER_SQLITE3_IMPLEMENTATION = "db/connection.ts";
const TEST_SUPPORT_DIR = "db/test-support";

function listProductionSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return relative(SRC_ROOT, path).split(sep).join("/") === TEST_SUPPORT_DIR
        ? []
        : listProductionSourceFiles(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

// `import ... from "better-sqlite3"`・`import type ...`・`export ... from`・
// 副作用だけの `import "better-sqlite3"`・動的 `import("better-sqlite3")`・
// `require("better-sqlite3")`、サブパス（`better-sqlite3/...`）のいずれも拾う。
const BETTER_SQLITE3_REFERENCE =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']better-sqlite3(?:\/[^"']*)?["']/;
// テスト専用の補助（生の接続を扱う `portFor`/`rawOf` 等）を製品コードから
// 参照していないこと（仮定 A1: 生の接続を使うのはテストだけ）。
const TEST_SUPPORT_REFERENCE = /["'][^"']*\/test-support\/[^"']*["']/;

describe("better-sqlite3 import boundary (#597 AC-1)", () => {
  it("only the better-sqlite3 implementation module imports better-sqlite3 among production sources", () => {
    const importers = listProductionSourceFiles(SRC_ROOT)
      .filter((file) => BETTER_SQLITE3_REFERENCE.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_ROOT, file).split(sep).join("/"))
      .sort();

    expect(importers).toEqual([BETTER_SQLITE3_IMPLEMENTATION]);
  });

  it("no production source imports the test-only helpers under db/test-support (spec assumption A1)", () => {
    const importers = listProductionSourceFiles(SRC_ROOT)
      .filter((file) => TEST_SUPPORT_REFERENCE.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_ROOT, file).split(sep).join("/"));

    expect(importers).toEqual([]);
  });
});
