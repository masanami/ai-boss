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

function listProductionSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "test-support" ? [] : listProductionSourceFiles(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

// `import ... from "better-sqlite3"`・`import type ...`・`export ... from`・
// 動的 `import("better-sqlite3")`・`require("better-sqlite3")` のいずれも拾う。
const BETTER_SQLITE3_REFERENCE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']better-sqlite3["']/;

describe("better-sqlite3 import boundary (#597 AC-1)", () => {
  it("only the better-sqlite3 implementation module imports better-sqlite3 among production sources", () => {
    const importers = listProductionSourceFiles(SRC_ROOT)
      .filter((file) => BETTER_SQLITE3_REFERENCE.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_ROOT, file).split(sep).join("/"))
      .sort();

    expect(importers).toEqual([BETTER_SQLITE3_IMPLEMENTATION]);
  });
});
