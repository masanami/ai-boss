import ts from "typescript";

/**
 * Node のグローバルへの値参照と `node:` からの値 import を AST で検出する
 * 静的検査（受入基準（S1）「実行基盤の非依存」）。
 *
 * **`server/src/core-entry.bundle.test.ts` の静的検査の写し**（仕様が「同じ
 * 方式」を求めているため、self-review で塞いだ抜け道〔`globalThis.process`・
 * `{ process }`・cast 越し・ブラケット記法 等〕ごと引き継ぐ）。`server/` は
 * S1 の変更対象外のため共通化せず写しで持つ。検査の規則を直すときは両方を直す。
 */

export const FORBIDDEN_GLOBAL_VALUE_IDENTIFIERS = new Set([
  "process",
  "Buffer",
  "require",
  "__dirname",
  "__filename",
  // PR #598 レビュー（P3）で追加。いずれも WebView に無い Node（CommonJS）の
  // グローバルで、コア（server/src）は宣言名以外で参照しない。
  "global",
  "setImmediate",
  "clearImmediate",
  "module",
  "exports",
]);

export interface StaticViolation {
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
const GLOBAL_OBJECT_ALIASES = new Set(["globalThis", "global", "self", "window"]);

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

export function checkSourceForForbiddenReferences(filePath: string, sourceText: string): StaticViolation[] {
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
