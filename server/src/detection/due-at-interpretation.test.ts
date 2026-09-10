import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * AC-10: `due_at` の解釈は `tasks/due-at.ts` に集約されており（ADR 0010 決定 5）、
 * 検知エンジンは `due_at` を引数にした `new Date(...)` を直接呼ばない。
 *
 * これは**パターンの不在を表明するテスト**である。`new Date(task.due_at)` が
 * 復活すると、その値は暦日ではなく瞬時として解釈され、`new Date("2026-09-05")`
 * が UTC 0 時になるため Asia/Tokyo では締切当日の 09:00 に超過扱いになる
 * （ADR 0010 背景）。振る舞いのテストは「たまたま等価な実装」を通してしまうため、
 * 集約そのものを直接固定する。
 */
const GUARDED_FILES = ["deadline-overdue.ts", "priority.ts"] as const;

// `new Date(...)` の引数に due_at 由来の識別子（`task.due_at` / `dueAt` 等）が
// 現れる形を検出する。
const NEW_DATE_FROM_DUE_AT = /new\s+Date\s*\([^)]*due_?at[^)]*\)/i;

/**
 * コメントを除いたソースを返す。対象ファイルの doc コメントは「`new Date(due_at)`
 * を直接呼ばない」と**禁止したい形そのものを散文で引用している**ため、素のまま
 * 突き合わせると解説文にマッチしてしまう。本テストが固定したいのは実コードなので、
 * 突き合わせ前にブロックコメント・行コメントを落とす。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("detection engine does not interpret due_at itself (AC-10)", () => {
  it.each(GUARDED_FILES)(
    "%s contains no `new Date(...)` built from due_at",
    (fileName) => {
      const code = stripComments(
        readFileSync(new URL(fileName, import.meta.url), "utf8"),
      );

      expect(code).not.toMatch(NEW_DATE_FROM_DUE_AT);
    },
  );

  it.each(GUARDED_FILES)("%s delegates to tasks/due-at.ts", (fileName) => {
    const code = stripComments(
      readFileSync(new URL(fileName, import.meta.url), "utf8"),
    );

    expect(code).toContain("toDueAtInstant");
  });

  // 上の不在アサーションが「パターンが何にもマッチしないから常に通る」状態に
  // なっていないことを、検出できるべき文字列で確かめる（恒真化の防止）。
  it("the guard pattern actually matches the shape it is meant to forbid", () => {
    expect("return new Date(task.due_at).getTime() < now.getTime();").toMatch(
      NEW_DATE_FROM_DUE_AT,
    );
    expect("const t = new Date(dueAt).getTime();").toMatch(
      NEW_DATE_FROM_DUE_AT,
    );
    expect("const t = new Date(startOfNextLocalDayIso(localDay));").not.toMatch(
      NEW_DATE_FROM_DUE_AT,
    );
  });
});
