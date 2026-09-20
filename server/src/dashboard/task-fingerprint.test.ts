import { describe, expect, it } from "vitest";
import type { Task } from "../tasks/task.js";
import { computeTaskFingerprint } from "./task-fingerprint.js";

/**
 * Issue #121: pure-function fingerprint over `listTasks(db)` results, used
 * to invalidate the dashboard "今日のひとこと" cache when task state changes
 * within the same day (not just across a date boundary).
 */

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "タスク",
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
    created_at: "2026-07-06T00:00:00.000Z",
    updated_at: "2026-07-06T00:00:00.000Z",
    completed_at: null,
    evidence_required: false,
    committed_start_at: null,
    committed_at: null,
    ...overrides,
  };
}

describe("computeTaskFingerprint", () => {
  it("is deterministic for the same input", () => {
    const tasks = [makeTask({ id: 1 }), makeTask({ id: 2 })];

    const first = computeTaskFingerprint(tasks);
    const second = computeTaskFingerprint(tasks);

    expect(first).toBe(second);
  });

  it("changes when a task is added", () => {
    const before = [makeTask({ id: 1 })];
    const after = [makeTask({ id: 1 }), makeTask({ id: 2 })];

    expect(computeTaskFingerprint(after)).not.toBe(computeTaskFingerprint(before));
  });

  it("changes when a task's updated_at changes", () => {
    const before = [makeTask({ id: 1, updated_at: "2026-07-06T00:00:00.000Z" })];
    const after = [makeTask({ id: 1, updated_at: "2026-07-06T01:00:00.000Z" })];

    expect(computeTaskFingerprint(after)).not.toBe(computeTaskFingerprint(before));
  });

  it("returns a stable value for zero tasks", () => {
    expect(computeTaskFingerprint([])).toBe(computeTaskFingerprint([]));
    expect(computeTaskFingerprint([])).toEqual(expect.any(String));
    expect(computeTaskFingerprint([]).length).toBeGreaterThan(0);
  });
});

/**
 * AC-1（機能仕様 docs/features/due-at-updated-at-semantics.md スライス S2 /
 * 決定 1・Issue #542）: フィンガープリントの射影は `Task` の**全フィールド**を
 * 含む。`Task` のフィールドがちょうど 1 つだけ異なる 2 つのタスク配列は、
 * 必ず異なるフィンガープリントになる。
 *
 * このテーブルを `{ [K in keyof Task]: ... }`（= `Record<keyof Task, ...>` の
 * フィールド別に型が付いた形）で宣言するのが本 AC の肝である。`Task` に
 * フィールドが増えたとき、テーブルの不足が `npm run typecheck` の失敗として
 * 継続的に検出される——本番コード側は射影をオブジェクトスプレッドで機械的に
 * 広げるだけなので、「射影が全フィールドを覆っている」ことの担保はこの型が
 * 単独で持つ（許可リストの陳腐化を型検査で塞ぐ）。
 *
 * 各値は `computeTaskFingerprint` にとって不透明な JSON 値でしかなく（時刻
 * としては一切解釈されない）、日時風の文字列も他と区別せずただのペイロード
 * として扱われる。したがってこのテーブルはタイムゾーンに依存しない。
 */
const FIELD_MUTATIONS: { [K in keyof Task]: { before: Task[K]; after: Task[K] } } = {
  id: { before: 1, after: 2 },
  title: { before: "タスク", after: "別のタスク" },
  description: { before: null, after: "説明が付いた" },
  category: { before: "work", after: "private" },
  priority: { before: null, after: "high" },
  due_at: { before: null, after: "2026-07-07" },
  status: { before: "todo", after: "in_progress" },
  boss_comment: { before: null, after: "まずこれをやれ" },
  estimated_minutes: { before: null, after: 30 },
  created_at: { before: "2026-07-06T00:00:00.000Z", after: "2026-07-06T02:00:00.000Z" },
  updated_at: { before: "2026-07-06T00:00:00.000Z", after: "2026-07-06T03:00:00.000Z" },
  completed_at: { before: null, after: "2026-07-06T04:00:00.000Z" },
  evidence_required: { before: false, after: true },
  committed_start_at: { before: null, after: "2026-07-06T05:00:00.000Z" },
  committed_at: { before: null, after: "2026-07-06T05:00:00.000Z" },
};

const MUTATED_FIELDS = Object.keys(FIELD_MUTATIONS) as (keyof Task)[];

describe("computeTaskFingerprint — AC-1: every Task field is part of the projection", () => {
  it("covers every field of Task in the mutation table", () => {
    // テーブルが空にならないことの下限確認（型はキーの不足を捕まえるが、
    // 「1 件も回っていない」という退行は型では見えないため）。
    expect(MUTATED_FIELDS.length).toBeGreaterThan(0);
  });

  it.each(MUTATED_FIELDS)(
    "changes when only `%s` differs",
    (field) => {
      const mutation = FIELD_MUTATIONS[field];
      // フィクスチャ自体が恒真でない（before と after が本当に違う）ことを
      // 先に表明する。同値のペアを置くとアサーションが無条件に通ってしまう。
      expect(mutation.after).not.toEqual(mutation.before);

      const before = [makeTask({ [field]: mutation.before } as Partial<Task>)];
      const after = [makeTask({ [field]: mutation.after } as Partial<Task>)];

      expect(computeTaskFingerprint(after)).not.toBe(
        computeTaskFingerprint(before),
      );
    },
  );
});
