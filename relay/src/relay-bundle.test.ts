import { beforeAll, describe, expect, it } from "vitest";
import { build, type BuildResult } from "esbuild";
import { readFileSync } from "node:fs";
import { relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSourceForForbiddenReferences } from "./test-support/forbidden-node-references.js";

/**
 * 受入基準（S1）「実行基盤の非依存と品質ゲート」: 中継の本体（`createRelayApp`
 * の入口 `index.ts`）を esbuild で `platform: "browser"` として束ね、
 * - 外部の指定子なしで解決できる（Node の組み込みを import していれば
 *   browser では解決できず失敗する）
 * - 入力に Node の組み込み（`node:` の指定子を含む）が含まれない
 * - `relay/src/` の入力ファイルに Node のグローバルへの値参照が無い
 *   （`core-entry.bundle.test.ts` と同じ AST の静的検査）
 * を確かめる。
 */

const ENTRY_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
const RELAY_SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(RELAY_SRC_DIR, "../..");

const NODE_BUILTIN_NAMES = [
  "fs",
  "path",
  "os",
  "crypto",
  "http",
  "https",
  "net",
  "tls",
  "stream",
  "buffer",
  "events",
  "url",
  "util",
  "child_process",
  "worker_threads",
  "zlib",
];

let buildResult: BuildResult<{ metafile: true; write: false }> | undefined;
let buildError: unknown;

beforeAll(async () => {
  try {
    buildResult = await build({
      entryPoints: [ENTRY_PATH],
      // メタファイルの入力のパスをリポジトリのルートからの相対にする（実行時の
      // cwd に依らず relay/src/ で絞り込めるようにする）。
      absWorkingDir: REPO_ROOT,
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
  } catch (error) {
    buildError = error;
  }
});

function inputPaths(): string[] {
  return Object.keys(buildResult!.metafile.inputs);
}

describe("中継の本体のバンドル検査", () => {
  it("platform: browser で外部の指定子なしに解決できる", () => {
    expect(buildError).toBeUndefined();
    expect(buildResult!.errors).toEqual([]);
  });

  it("入力に Node の組み込み（node: の指定子を含む）が無い", () => {
    const paths = inputPaths();
    expect(paths.some((path) => path.startsWith("node:"))).toBe(false);
    for (const name of NODE_BUILTIN_NAMES) {
      expect(paths).not.toContain(name);
    }
  });

  it("入力は relay/src の中継の本体と hono だけ（テストの支援コードを含まない）", () => {
    const paths = inputPaths();
    const relaySources = paths.filter((path) => path.startsWith("relay/src/"));
    expect(relaySources.length).toBeGreaterThan(0);
    expect(relaySources.filter((path) => path.includes("test"))).toEqual([]);
    expect(paths.every((path) => path.startsWith("relay/src/") || path.includes("node_modules/hono/"))).toBe(true);
  });

  it("relay/src の入力ファイルに Node のグローバルへの値参照・node: からの値 import が無い", () => {
    const relaySources = inputPaths().filter((path) => path.startsWith("relay/src/"));
    const violations = relaySources.flatMap((path) => {
      const absolute = resolvePath(REPO_ROOT, path);
      return checkSourceForForbiddenReferences(relative(REPO_ROOT, absolute), readFileSync(absolute, "utf8"));
    });
    expect(violations).toEqual([]);
  });

  it("静的検査は Node のグローバルへの値参照を検出する（検査自体が働くことの確認）", () => {
    const violations = checkSourceForForbiddenReferences(
      "sample.ts",
      [
        "const a = process.env.X;",
        "const b = globalThis.Buffer;",
        "const c = { setImmediate };",
        'import { readFileSync } from "node:fs";',
        "type T = typeof process;",
      ].join("\n"),
    );
    expect(violations.map((violation) => violation.line)).toEqual([1, 2, 3, 4]);
  });
});
