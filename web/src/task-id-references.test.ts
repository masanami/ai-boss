import { describe, expect, it } from "vitest";
import { resolveTaskIdReferences } from "./task-id-references";
import type { Task } from "./task";

function makeTask(overrides: Partial<Task> & { id: number }): Task {
  return {
    title: `task-${overrides.id}`,
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
    created_at: new Date(2026, 6, 5).toISOString(),
    updated_at: new Date(2026, 6, 5).toISOString(),
    completed_at: null,
    evidence_required: false,
    ...overrides,
  };
}

/** Concatenates every segment's own text — must always reproduce the input
 * verbatim regardless of which segments resolved (受入基準: textContent一致). */
function textOf(segments: ReturnType<typeof resolveTaskIdReferences>): string {
  return segments.map((segment) => segment.text).join("");
}

describe("resolveTaskIdReferences", () => {
  it("resolves a #<id> that matches a task in the list to a task-reference segment carrying that task", () => {
    const task1 = makeTask({ id: 1, title: "資料作成" });

    const segments = resolveTaskIdReferences("#1 を進めろ", [task1]);

    expect(segments).toEqual([
      { kind: "task-reference", text: "#1", task: task1 },
      { kind: "text", text: " を進めろ" },
    ]);
  });

  it("leaves an id with no matching task as plain text (#9999 not in the list)", () => {
    const task1 = makeTask({ id: 1 });

    const segments = resolveTaskIdReferences("#9999 は存在しない", [task1]);

    expect(segments.some((segment) => segment.kind === "task-reference")).toBe(
      false,
    );
    expect(textOf(segments)).toBe("#9999 は存在しない");
  });

  it("resolves nothing when the task list is unavailable (loading/error, represented as null)", () => {
    const segments = resolveTaskIdReferences("#1 を進めろ", null);

    expect(segments).toEqual([{ kind: "text", text: "#1 を進めろ" }]);
  });

  // 受入基準: 最長一致（三角測量 — #1 だけでは一般化されない）
  it("matches the longest run of digits: #12 resolves to task 12, not task 1 plus a stray 2, when both exist", () => {
    const task1 = makeTask({ id: 1 });
    const task12 = makeTask({ id: 12, title: "第12案件" });

    const segments = resolveTaskIdReferences("#12 を先に", [task1, task12]);

    expect(segments[0]).toEqual({
      kind: "task-reference",
      text: "#12",
      task: task12,
    });
    expect(textOf(segments)).toBe("#12 を先に");
  });

  it("does not resolve #12 when only task 1 exists in the list", () => {
    const task1 = makeTask({ id: 1 });

    const segments = resolveTaskIdReferences("#12 を先に", [task1]);

    expect(segments.some((segment) => segment.kind === "task-reference")).toBe(
      false,
    );
  });

  it("requires an exact decimal match: #01 does not resolve to task 1", () => {
    const task1 = makeTask({ id: 1 });

    const segments = resolveTaskIdReferences("#01 を進めろ", [task1]);

    expect(segments.some((segment) => segment.kind === "task-reference")).toBe(
      false,
    );
  });

  it("does not resolve full-width ＃1 even when task 1 exists", () => {
    const task1 = makeTask({ id: 1 });

    const segments = resolveTaskIdReferences("＃1 を進めろ", [task1]);

    expect(segments.some((segment) => segment.kind === "task-reference")).toBe(
      false,
    );
    expect(textOf(segments)).toBe("＃1 を進めろ");
  });

  it("does not resolve full-width digits (#１) even when task 1 exists", () => {
    const task1 = makeTask({ id: 1 });

    const segments = resolveTaskIdReferences("#１ を進めろ", [task1]);

    expect(segments).toEqual([{ kind: "text", text: "#１ を進めろ" }]);
  });

  // 決定3: `#` の直前の文字には条件を付けない。
  it.each(["タスク#1 を進めろ", "##1 を進めろ"])(
    "resolves #1 regardless of the character before the # (%s)",
    (text) => {
      const task1 = makeTask({ id: 1, title: "資料作成" });

      const segments = resolveTaskIdReferences(text, [task1]);

      expect(
        segments.filter((segment) => segment.kind === "task-reference"),
      ).toEqual([{ kind: "task-reference", text: "#1", task: task1 }]);
      expect(textOf(segments)).toBe(text);
    },
  );

  it("resolves multiple independent references in the same text", () => {
    const task1 = makeTask({ id: 1, title: "一つ目" });
    const task2 = makeTask({ id: 2, title: "二つ目" });

    const segments = resolveTaskIdReferences("#1 と #2 を並行して", [
      task1,
      task2,
    ]);

    expect(
      segments.filter((segment) => segment.kind === "task-reference"),
    ).toEqual([
      { kind: "task-reference", text: "#1", task: task1 },
      { kind: "task-reference", text: "#2", task: task2 },
    ]);
    expect(textOf(segments)).toBe("#1 と #2 を並行して");
  });

  it("returns the original text unchanged when there is no # at all", () => {
    const segments = resolveTaskIdReferences("特に指示はない", []);

    expect(segments).toEqual([{ kind: "text", text: "特に指示はない" }]);
  });
});
