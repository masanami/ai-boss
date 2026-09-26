import { beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import type { BuildResult, Metafile } from "esbuild";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";

/**
 * 受入基準（S1）1〜7・12・14 を固定するバンドル検査（機能仕様
 * docs/features/tauri-in-app-runtime.md 実装計画③）。
 *
 * `core-entry.ts` を esbuild で `platform: "browser"` として束ね、
 * - AC1: 解決できない import が無いこと（外部指定なし）
 * - AC2〜5: バンドルの入力（メタファイル）に禁止パッケージ/モジュールが
 *   含まれないこと
 * - AC6: `process`/`require` が未定義のグローバルで評価しても例外にならない
 *   こと
 * - AC7: 登録済み LLM バックエンドが0件であること
 * - AC12: `Buffer` が未定義のグローバルでも証跡ルートが成功すること
 * - 静的検査: `server/src/` 配下の入力ファイルに禁止識別子・`node:` からの
 *   値 import が無いこと（Issue #594 コメント P2 — 既定引数の遅延評価は
 *   評価だけでは検出できないため、AST 検査で補う）
 * を確認する。
 */

const ENTRY_PATH = fileURLToPath(new URL("./core-entry.ts", import.meta.url));

const FORBIDDEN_PACKAGE_SUBSTRINGS = [
  "@anthropic-ai/claude-agent-sdk",
  "@hono/node-server",
  "@anthropic-ai/sdk",
] as const;

const FORBIDDEN_CLAUDE_CODE_BACKEND_SUBSTRING = "llm/backends/claude-code-backend.ts";

function metafileInputPaths(metafile: Metafile): string[] {
  return Object.keys(metafile.inputs);
}

function includesAnyInput(paths: string[], substring: string): boolean {
  return paths.some((p) => p.includes(substring));
}

// ---------------------------------------------------------------------------
// 静的検査（TypeScript コンパイラ API）: process/Buffer/require/__dirname/
// __filename の値参照と、node: からの値 import が無いことを検査する。
// ---------------------------------------------------------------------------

const FORBIDDEN_GLOBAL_VALUE_IDENTIFIERS = new Set([
  "process",
  "Buffer",
  "require",
  "__dirname",
  "__filename",
]);

interface StaticViolation {
  file: string;
  line: number;
  text: string;
}

/**
 * `(file,name)` 除外の判定。**`ShorthandPropertyAssignment`（`{ process }`）は
 * 含めない** — self-review（code-reviewer/design-reviewer 双方が独立に
 * 指摘・CONFIRMED）: `{ process }` は `{ process: process }` の糖衣構文で
 * あり、スコープ内の `process`（多くの場合グローバル）への**値参照**その
 * ものである。宣言名ではないため、ここで除外すると `{ process }`/
 * `{ Buffer }` が検知をすり抜けていた。
 */
function isDeclarationOrBindingName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isClassDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) {
    // `const { process } = globalThis;`（`propertyName` を伴わない、つまり
    // 分割代入の「省略形」）は `{ process }` と同じ構図の値参照
    // — self-review（design-reviewer, CONFIRMED, 2周目）。`propertyName` を
    // 伴う `const { process: p } = globalThis;` は元々この分岐に当たらない
    // （`parent.name` は "p" 側であり、"process" 側の識別子は
    // `parent.propertyName` — 既に除外されず検知される）。
    return !isGlobalAliasDestructuringBindingElement(parent);
  }
  if (ts.isImportSpecifier(parent) && parent.name === node) return true;
  if (ts.isImportClause(parent) && parent.name === node) return true;
  if (ts.isNamespaceImport(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodSignature(parent) && parent.name === node) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  return false;
}

/** グローバルオブジェクトの別名。`globalThis.process` / `global.Buffer` /
 * `self.require` はいずれも通常の（安全な）プロパティ名位置の"foo.process"
 * とは違い、対象の識別子そのものへの値参照である（self-review:
 * design-reviewer が `globalThis.process.env` の検知漏れを CONFIRMED）。 */
const GLOBAL_OBJECT_ALIASES = new Set(["globalThis", "global", "self"]);

/**
 * Unwraps non-semantic wrapper nodes (`(x)` / `x as T` / `x satisfies T` /
 * `x!`) to get at the underlying expression. self-review（code-reviewer,
 * PLAUSIBLE, 2周目）: without this, `(globalThis as any).process` /
 * `globalThis!.process` evaded {@link isNamePosition}'s
 * {@link GLOBAL_OBJECT_ALIASES} check, since that check requires the object
 * expression to be a bare `ts.Identifier` — a cast/paren/non-null wrapper
 * made it fail silently. No file under `server/src/` (excluding this test)
 * currently writes `globalThis` through a cast, so this had no live impact,
 * but the check exists specifically to catch *future* evasions, so closing
 * this gap now (rather than waiting for a real occurrence) is the point.
 */
function unwrapNonSemanticExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    // すべて `.expression` に内側の式を持つノード種別（4種とも同じ形）。
    current = current.expression;
  }
  return current;
}

function isGlobalObjectAliasExpression(expression: ts.Expression): boolean {
  const unwrapped = unwrapNonSemanticExpression(expression);
  return ts.isIdentifier(unwrapped) && GLOBAL_OBJECT_ALIASES.has(unwrapped.text);
}

/**
 * `const { process } = globalThis;`（`propertyName` を伴わない分割代入）は
 * `{ process }` と同じ構図の値参照である — self-review（design-reviewer,
 * CONFIRMED, 2周目）。`propertyName` を伴う形（`const { process: p } =
 * globalThis;`）はこの関数の対象外（呼び出し元 `isDeclarationOrBindingName`
 * のコメント参照）。
 */
function isGlobalAliasDestructuringBindingElement(bindingElement: ts.BindingElement): boolean {
  if (bindingElement.propertyName) {
    return false;
  }
  const bindingPattern = bindingElement.parent;
  if (!ts.isObjectBindingPattern(bindingPattern)) {
    return false;
  }
  const owner = bindingPattern.parent;
  const initializer = ts.isVariableDeclaration(owner) ? owner.initializer : undefined;
  return initializer !== undefined && isGlobalObjectAliasExpression(initializer);
}

/** Property-name / qualified-type-name position: `foo.process`（`foo` が
 * {@link isGlobalObjectAliasExpression} でない通常のオブジェクト）や
 * `Foo.process`（型の qualified name）は、対象識別子への値参照ではないので
 * 安全に除外できる。一方 `globalThis.process`（`(globalThis as
 * any).process` のような cast 越しも含む）はここで除外しない — 除外しない
 * ことで、`checkSourceForForbiddenReferences` の一般的な識別子走査（`visit`
 * 内、この関数の呼び出し元）がそのまま "process" を違反として検出する
 * （この関数自身は専用の検出ロジックを持たない — 除外しないことで一般走査
 * に委ねるだけ。「別チェックで拾う」という説明は誤りだった — self-review:
 * code-reviewer, CONFIRMED, 2周目。下記 visit 内のコメント参照）。ブラケット
 * 記法（`globalThis['Buffer']`）は識別子ではなく文字列リテラルなのでこの
 * 経路には乗らず、`visit` 内の `ElementAccessExpression` 専用チェックが
 * 別途拾う。 */
function isNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === node &&
    !isGlobalObjectAliasExpression(parent.expression)
  ) {
    return true;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  return false;
}

/**
 * Climbs the ancestor chain looking for a type-position container
 * (`TypeReferenceNode`, `typeof X` type queries, interface/type-alias
 * bodies, …). Stops at the nearest statement/expression boundary so it
 * doesn't walk past the enclosing declaration.
 *
 * **例外**: `class X extends Buffer {}` の `Buffer` は
 * `ExpressionWithTypeArguments`（`HeritageClause` の `extends` 節）に
 * 包まれており、`ts.isTypeNode()` は（`implements`/型注釈と区別せず）
 * これも真にしてしまう。しかし class の `extends` 節は**値**（基底クラスの
 * コンストラクタ）を指すので、この形だけは型位置として扱わない
 * （self-review: design-reviewer が CONFIRMED）。`ts.isClassLike`（クラス
 * **宣言**・クラス**式**の両方にマッチ）を使う — `ts.isClassDeclaration`
 * だけだと `const X = class extends Buffer {};`（クラス式）が抜け落ちる
 * （self-review: code-reviewer/design-reviewer 双方が独立に指摘・CONFIRMED、
 * 2周目）。
 */
function isWithinTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isExpressionWithTypeArguments(current) &&
      current.parent &&
      ts.isHeritageClause(current.parent) &&
      current.parent.token === ts.SyntaxKind.ExtendsKeyword &&
      ts.isClassLike(current.parent.parent)
    ) {
      return false;
    }
    if (
      ts.isTypeReferenceNode(current) ||
      ts.isTypeQueryNode(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      (ts.isTypeNode(current) && !ts.isIdentifier(current))
    ) {
      return true;
    }
    if (ts.isExpressionStatement(current) || ts.isSourceFile(current)) {
      break;
    }
    current = current.parent;
  }
  return false;
}

/**
 * `import { readFile } from "node:fs"` のような値 import かどうかを判定する
 * （`import type { ... }` の型だけの import は対象外）。クローズ全体の
 * `isTypeOnly` だけでなく、**個別 specifier の `isTypeOnly`
 * （`import { type Stats, readFile } from "node:fs"` の `type Stats` 部分）
 * も見る** — self-review（code-reviewer）: クローズ単位でしか見ていないと、
 * 個別 specifier だけが type-only な import を値 import と誤検知していた。
 * 逆に、バインディングを一つも持たない副作用 import（`import "node:fs";`）
 * は常に値 import として扱う。
 */
function importDeclarationHasValueBinding(node: ts.ImportDeclaration): boolean {
  const importClause = node.importClause;
  if (!importClause) {
    return true;
  }
  if (importClause.isTypeOnly) {
    return false;
  }
  if (importClause.name) {
    return true;
  }
  const bindings = importClause.namedBindings;
  if (!bindings) {
    return false;
  }
  if (ts.isNamespaceImport(bindings)) {
    return true;
  }
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function checkSourceForForbiddenReferences(filePath: string, sourceText: string): StaticViolation[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const violations: StaticViolation[] = [];

  function reportAt(node: ts.Node, text: string): void {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ file: filePath, line: line + 1, text });
  }

  function visit(node: ts.Node): void {
    // `globalThis['process']` / `(globalThis as any)['Buffer']` —
    // bracket-notation access with a string literal argument is never an
    // `Identifier` node, so it is invisible to the general identifier walk
    // below no matter how `isNamePosition` is defined. Handled here as a
    // dedicated case (using {@link isGlobalObjectAliasExpression} so a
    // cast/paren-wrapped object expression is still recognized — self-review:
    // code-reviewer, PLAUSIBLE, 2周目).
    // (Plain-dot form `globalThis.process` does NOT need a dedicated case:
    // `isNamePosition` deliberately does not exclude it — see its doc
    // comment — so the general identifier walk already reports it once;
    // adding a second case here would just double-report the same node.)
    if (
      ts.isElementAccessExpression(node) &&
      isGlobalObjectAliasExpression(node.expression) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      FORBIDDEN_GLOBAL_VALUE_IDENTIFIERS.has(node.argumentExpression.text)
    ) {
      reportAt(
        node.argumentExpression,
        `forbidden identifier "${node.argumentExpression.text}" via ${node.expression.getText(sourceFile)}[...]`,
      );
    }

    if (
      ts.isIdentifier(node) &&
      FORBIDDEN_GLOBAL_VALUE_IDENTIFIERS.has(node.text) &&
      !isDeclarationOrBindingName(node) &&
      !isNamePosition(node) &&
      !isWithinTypePosition(node)
    ) {
      reportAt(node, `forbidden identifier "${node.text}"`);
    }

    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith("node:") &&
      importDeclarationHasValueBinding(node)
    ) {
      reportAt(node, `value import from "${node.moduleSpecifier.text}"`);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

// ---------------------------------------------------------------------------
// vm サンドボックス: WKWebView 相当の Web 標準グローバルだけを渡し、
// process/require/Buffer/module/__dirname を渡さない。
// ---------------------------------------------------------------------------

function createSandboxContext(overrides: Record<string, unknown> = {}): vm.Context {
  const sandbox: Record<string, unknown> = {
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Request,
    Response,
    Headers,
    ReadableStream,
    WritableStream,
    TransformStream,
    AbortController,
    AbortSignal,
    crypto,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    structuredClone,
    File,
    FormData,
    Blob,
    fetch,
    ...overrides,
  };
  const context = vm.createContext(sandbox);
  (context as Record<string, unknown>).globalThis = context;
  return context;
}

interface CoreExports {
  createCoreApp: (
    db: unknown,
    env: Record<string, string | undefined>,
    options?: { llmBackend?: string; evidenceStore?: unknown },
  ) => { request: (input: string | Request, init?: RequestInit) => Promise<Response> };
  registeredCoreLlmBackendNames: () => string[];
}

let buildResult: BuildResult | undefined;
let buildError: unknown;
let bundleCode = "";

beforeAll(async () => {
  // esbuild's `build()` *rejects* the promise when there are unresolved
  // imports (verified directly: a `node:fs` import under `platform:
  // "browser"` throws rather than resolving with a populated `errors`
  // array) — so `beforeAll` itself throwing previously made every test in
  // this file fail/skip with a generic suite-level error, and the AC1
  // assertion below it (`expect(buildResult.errors).toEqual([])`) could
  // never actually observe a non-empty `errors` array: by the time that
  // line ran, either `build()` had already thrown (never reaching the
  // assertion) or it had resolved successfully (`errors` always `[]`) —
  // i.e. the assertion was tautological (self-review: design-reviewer,
  // CONFIRMED). Catching the rejection here lets AC1's own `it` surface the
  // real esbuild diagnostic as its failure message instead.
  try {
    buildResult = await build({
      entryPoints: [ENTRY_PATH],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "AiBossCore",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    bundleCode = buildResult.outputFiles![0].text;
  } catch (err) {
    buildError = err;
  }
});

describe("core-entry bundle — AC1 (esbuild で platform=browser として束ねると解決できない import が0件)", () => {
  it("has zero build errors and no external specifiers", () => {
    if (buildError) {
      throw buildError;
    }
    expect(buildResult).toBeDefined();
    expect(buildResult!.errors).toEqual([]);
  });
});

describe("core-entry bundle — AC2〜5 (バンドルの入力に禁止パッケージが含まれない)", () => {
  it.each(FORBIDDEN_PACKAGE_SUBSTRINGS)("does not include %s among the bundle inputs", (substring) => {
    const inputs = metafileInputPaths(buildResult!.metafile!);
    expect(includesAnyInput(inputs, substring)).toBe(false);
  });

  it("does not include llm/backends/claude-code-backend.ts among the bundle inputs", () => {
    const inputs = metafileInputPaths(buildResult!.metafile!);
    expect(includesAnyInput(inputs, FORBIDDEN_CLAUDE_CODE_BACKEND_SUBSTRING)).toBe(false);
  });
});

describe("core-entry bundle — AC6/AC7 (process/require が無いグローバルで評価しても例外にならない・登録LLMバックエンド0件)", () => {
  it("evaluates without throwing in a context with no process/require/Buffer/module", () => {
    const context = createSandboxContext();
    expect(() => vm.runInContext(bundleCode, context)).not.toThrow();
    expect(typeof (context as Record<string, unknown>).process).toBe("undefined");
    expect(typeof (context as Record<string, unknown>).require).toBe("undefined");
  });

  it("exports createCoreApp and registeredCoreLlmBackendNames", () => {
    const context = createSandboxContext();
    vm.runInContext(bundleCode, context);
    const exported = (context as Record<string, unknown>).AiBossCore as CoreExports;
    expect(typeof exported.createCoreApp).toBe("function");
    expect(typeof exported.registeredCoreLlmBackendNames).toBe("function");
  });

  it("registers zero LLM backends (オーナーの決定 Q4-c)", () => {
    const context = createSandboxContext();
    vm.runInContext(bundleCode, context);
    const exported = (context as Record<string, unknown>).AiBossCore as CoreExports;
    expect(exported.registeredCoreLlmBackendNames()).toEqual([]);
  });
});

describe("core-entry bundle — smoke test (vm 内で構築した app が実 DB への最小リクエストに応答する)", () => {
  // self-review（code-reviewer, CONFIRMED）: このブロックはもともと「Issue
  // #594 コメント P2（既定引数の遅延評価は評価だけでは検出できない）への
  // 対処」と称していたが、`createCoreApp` は `/api/health` を含むどの
  // ルーターにも `env` を明示的に渡す（`core-app.ts` 参照）ため、
  // `dashboard-routes.ts`/`reports-routes.ts` の既定引数はそもそも呼び出し
  // 経路上で評価されず、この smoke test では検出できない — P2 の実際の
  // 担保は「静的検査」ブロック（AST 走査）だけが持つ。この describe 名は
  // 実際に検証している内容（vm 内で構築した app が、実 DB を使った最小の
  // リクエストに例外なく応答すること）に合わせて改めた。
  //
  // また、CLAUDE.md のテスト方針「Mockしない: SQLite（一時ファイル or
  // `:memory:` で実 DB を使う）」に従い、`db.prepare` のみを実装したスタブ
  // ではなく実際の better-sqlite3（`:memory:`）を使う（self-review:
  // code-reviewer, CONFIRMED）。
  it("answers GET /api/health without throwing, using a real :memory: db", async () => {
    const context = createSandboxContext();
    vm.runInContext(bundleCode, context);
    const exported = (context as Record<string, unknown>).AiBossCore as CoreExports;

    const db = openDatabase(":memory:");
    runMigrations(db);
    const app = exported.createCoreApp(db, {});

    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: true });

    db.close();
  });
});

describe("core-entry bundle — AC12 (グローバル Buffer が未定義でも証跡ルートが成功する)", () => {
  it("saves file evidence bytes through an in-memory EvidenceStore while Buffer is undefined", async () => {
    // `createSandboxContext` は `Buffer` をサンドボックスへ渡さない —
    // vm のコンテキストは Node のグローバル（`Buffer`/`process`/`require`）を
    // 自動継承しないため、この時点でバンドル済みコードから見える `Buffer` は
    // 既に未定義。プロセス全体の実グローバル `Buffer` を書き換える
    // （`vi.stubGlobal("Buffer", undefined)` 等）と vitest 自身の
    // worker間通信（内部で `Buffer` を使う）が壊れるため、実グローバルには
    // 触れない — vm コンテキストの隔離だけで AC12 の「Buffer 未定義」を
    // 再現する。
    const context = createSandboxContext();
    vm.runInContext(bundleCode, context);
    const exported = (context as Record<string, unknown>).AiBossCore as CoreExports;

    // 実 DB は :memory: の better-sqlite3 + マイグレーション（テストは Node
    // で走るので DB は現行のまま — 機能仕様の指示どおり）。
    const db = openDatabase(":memory:");
    runMigrations(db);

    const stored = new Map<string, Uint8Array>();
    const memoryEvidenceStore = {
      write(storedFilename: string, data: Uint8Array) {
        stored.set(storedFilename, data);
      },
      read(storedFilename: string) {
        return stored.get(storedFilename);
      },
      remove(storedFilename: string) {
        stored.delete(storedFilename);
      },
    };

    const app = exported.createCoreApp(db, {}, { evidenceStore: memoryEvidenceStore });

    const createTaskRes = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "証跡テスト用タスク" }),
    });
    expect(createTaskRes.status).toBe(201);
    const task = (await createTaskRes.json()) as { id: number };

    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const file = new File([bytes], "note.txt", { type: "text/plain" });
    const formData = new FormData();
    formData.set("file", file);

    const uploadRes = await app.request(`/api/tasks/${task.id}/evidences`, {
      method: "POST",
      body: formData,
    });
    expect(uploadRes.status).toBe(201);
    const evidence = (await uploadRes.json()) as { stored_filename: string };

    const savedBytes = stored.get(evidence.stored_filename);
    expect(savedBytes).toBeDefined();
    expect(Array.from(savedBytes as Uint8Array)).toEqual(Array.from(bytes));

    db.close();
  });
});

describe("core-entry bundle — 静的検査 (server/src/ 配下の入力に process/Buffer/require/__dirname/__filename の値参照・node: の値importが無い)", () => {
  it("has zero forbidden identifier/import occurrences across every bundled server/src/*.ts input", () => {
    const inputs = metafileInputPaths(buildResult!.metafile!).filter(
      (p) => p.includes("src/") && p.endsWith(".ts") && !p.includes("node_modules"),
    );
    expect(inputs.length).toBeGreaterThan(0);

    const violations = inputs.flatMap((relativePath) => {
      const absolutePath = resolvePath(process.cwd(), relativePath);
      const sourceText = readFileSync(absolutePath, "utf-8");
      return checkSourceForForbiddenReferences(relativePath, sourceText);
    });

    if (violations.length > 0) {
      const details = violations.map((v) => `${v.file}:${v.line}: ${v.text}`).join("\n");
      throw new Error(`forbidden references found in the core bundle:\n${details}`);
    }
    expect(violations).toEqual([]);
  });
});
