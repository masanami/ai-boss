import { describe, expect, it } from "vitest";
import {
  NO_RECORDS_NOTE,
  renderWorkLog,
  type RenderWorkLogActivityEntry,
  type RenderWorkLogDecisionEntry,
  type RenderWorkLogInput,
} from "./render-work-log.js";

function baseInput(overrides: Partial<RenderWorkLogInput> = {}): RenderWorkLogInput {
  return {
    date: new Date(2026, 7, 14), // 2026-08-14（金）
    decisions: [],
    activityEvents: [],
    ...overrides,
  };
}

function activityEntry(overrides: Partial<RenderWorkLogActivityEntry> = {}): RenderWorkLogActivityEntry {
  return {
    id: 1,
    type: "task_start",
    taskTitle: "タスクA",
    note: null,
    expectedMinutes: null,
    createdAt: new Date(2026, 7, 14, 9, 5),
    ...overrides,
  };
}

function decisionEntry(overrides: Partial<RenderWorkLogDecisionEntry> = {}): RenderWorkLogDecisionEntry {
  return {
    id: 1,
    status: "active",
    content: "本日のノルマは◯◯を完了させることとする",
    createdAt: new Date(2026, 7, 14, 9, 30),
    ...overrides,
  };
}

describe("renderWorkLog — 表題", () => {
  it("renders the title with the local date and a single-kanji weekday", () => {
    const md = renderWorkLog(baseInput({ date: new Date(2026, 7, 14) })); // 金曜日

    expect(md).toContain("# 作業ログ 2026-08-14（金）");
  });

  it.each([
    [new Date(2026, 7, 16), "日"],
    [new Date(2026, 7, 17), "月"],
    [new Date(2026, 7, 18), "火"],
  ])("uses the correct single-kanji weekday for %s", (date, kanji) => {
    const md = renderWorkLog(baseInput({ date }));
    expect(md).toContain(`（${kanji}）`);
  });
});

describe("renderWorkLog — 記録なし", () => {
  it("renders the fixed '（記録なし）' line when there are no decisions and no activity events", () => {
    const md = renderWorkLog(baseInput());

    expect(md).toContain(NO_RECORDS_NOTE);
  });
});

describe("renderWorkLog — activity_events の行フォーマット", () => {
  it("renders task_start as '着手: {タスク名}'", () => {
    const md = renderWorkLog(
      baseInput({
        activityEvents: [
          activityEntry({ type: "task_start", taskTitle: "タスクA", createdAt: new Date(2026, 7, 14, 9, 5) }),
        ],
      }),
    );

    expect(md).toContain("- 09:05 着手: タスクA");
  });

  it("renders task_update as 'タスク更新: {タスク名}'", () => {
    const md = renderWorkLog(
      baseInput({
        activityEvents: [
          activityEntry({ type: "task_update", taskTitle: "タスクB", createdAt: new Date(2026, 7, 14, 14, 20) }),
        ],
      }),
    );

    expect(md).toContain("- 14:20 タスク更新: タスクB");
  });

  it("renders break_start as '休憩開始' (no task name)", () => {
    const md = renderWorkLog(
      baseInput({
        activityEvents: [
          activityEntry({ type: "break_start", taskTitle: null, createdAt: new Date(2026, 7, 14, 10, 0) }),
        ],
      }),
    );

    expect(md).toContain("- 10:00 休憩開始");
  });

  it("renders break_end as '休憩終了'", () => {
    const md = renderWorkLog(
      baseInput({
        activityEvents: [
          activityEntry({ type: "break_end", taskTitle: null, createdAt: new Date(2026, 7, 14, 10, 12) }),
        ],
      }),
    );

    expect(md).toContain("- 10:12 休憩終了");
  });

  it("renders checkin as 'チェックイン'", () => {
    const md = renderWorkLog(
      baseInput({
        activityEvents: [
          activityEntry({ type: "checkin", taskTitle: null, note: "順調に進行中", createdAt: new Date(2026, 7, 14, 13, 0) }),
        ],
      }),
    );

    expect(md).toContain("- 13:00 チェックイン — 順調に進行中");
  });

  it("appends '（予定 {n}分）' for task_start with expected_minutes", () => {
    const md = renderWorkLog(
      baseInput({
        activityEvents: [
          activityEntry({ type: "task_start", taskTitle: "タスクA", expectedMinutes: 60 }),
        ],
      }),
    );

    expect(md).toContain("着手: タスクA（予定 60分）");
  });

  it("appends '（予定 {n}分）' for break_start with expected_minutes", () => {
    const md = renderWorkLog(
      baseInput({
        activityEvents: [
          activityEntry({ type: "break_start", taskTitle: null, expectedMinutes: 15 }),
        ],
      }),
    );

    expect(md).toContain("休憩開始（予定 15分）");
  });

  it("does not append '（予定 ...分）' for task_update/break_end/checkin even if expectedMinutes is set", () => {
    const md = renderWorkLog(
      baseInput({
        activityEvents: [
          activityEntry({ type: "task_update", taskTitle: "タスクB", expectedMinutes: 30 }),
        ],
      }),
    );

    expect(md).not.toContain("予定");
  });

  it("appends '（予定 {n}分） — {note}' in this order when both are present", () => {
    const md = renderWorkLog(
      baseInput({
        activityEvents: [
          activityEntry({ type: "task_start", taskTitle: "タスクA", expectedMinutes: 60, note: "集中したい" }),
        ],
      }),
    );

    expect(md).toContain("着手: タスクA（予定 60分） — 集中したい");
  });

  it("renders '（タスク未指定）' when taskTitle is null (null task_id or missing task, indistinguishable)", () => {
    const md = renderWorkLog(
      baseInput({
        activityEvents: [activityEntry({ type: "task_start", taskTitle: null })],
      }),
    );

    expect(md).toContain("着手: （タスク未指定）");
  });
});

describe("renderWorkLog — 決定の行フォーマット", () => {
  it("renders an active decision as '決定: {content}'", () => {
    const md = renderWorkLog(
      baseInput({ decisions: [decisionEntry({ status: "active", content: "本日のノルマ確定" })] }),
    );

    expect(md).toContain("決定: 本日のノルマ確定");
    expect(md).not.toContain("決定（");
  });

  it("renders a revised decision as '決定（改訂済み）: {content}'", () => {
    const md = renderWorkLog(
      baseInput({ decisions: [decisionEntry({ status: "revised", content: "△△を先に着手する" })] }),
    );

    expect(md).toContain("決定（改訂済み）: △△を先に着手する");
  });

  it("renders a withdrawn decision as '決定（撤回）: {content}'", () => {
    const md = renderWorkLog(
      baseInput({ decisions: [decisionEntry({ status: "withdrawn", content: "撤回された決定" })] }),
    );

    expect(md).toContain("決定（撤回）: 撤回された決定");
  });
});

describe("renderWorkLog — 並び順", () => {
  it("merges decisions and activity events by created_at ascending", () => {
    const md = renderWorkLog(
      baseInput({
        activityEvents: [
          activityEntry({ id: 1, type: "task_start", taskTitle: "タスクA", createdAt: new Date(2026, 7, 14, 9, 5) }),
        ],
        decisions: [decisionEntry({ id: 1, createdAt: new Date(2026, 7, 14, 9, 30) })],
      }),
    );

    expect(md.indexOf("09:05")).toBeLessThan(md.indexOf("09:30"));
  });

  it("places an activity event before a decision when created_at is identical", () => {
    const sameTime = new Date(2026, 7, 14, 10, 0);
    const md = renderWorkLog(
      baseInput({
        activityEvents: [activityEntry({ id: 1, type: "checkin", taskTitle: null, createdAt: sameTime })],
        decisions: [decisionEntry({ id: 1, content: "同時刻の決定", createdAt: sameTime })],
      }),
    );

    expect(md.indexOf("チェックイン")).toBeLessThan(md.indexOf("同時刻の決定"));
  });

  it("orders same-kind entries with identical created_at by id ascending, regardless of input order", () => {
    const sameTime = new Date(2026, 7, 14, 10, 0);
    const md = renderWorkLog(
      baseInput({
        decisions: [
          decisionEntry({ id: 5, content: "後で登録された決定", createdAt: sameTime }),
          decisionEntry({ id: 2, content: "先に登録された決定", createdAt: sameTime }),
        ],
      }),
    );

    expect(md.indexOf("先に登録された決定")).toBeLessThan(md.indexOf("後で登録された決定"));
  });
});

describe("renderWorkLog — 動的値のエスケープ・正規化", () => {
  it("normalizes a task title containing a newline to a single line", () => {
    const md = renderWorkLog(
      baseInput({ activityEvents: [activityEntry({ taskTitle: "1行目\n2行目" })] }),
    );

    expect(md).toContain("着手: 1行目 2行目");
    expect(md).not.toContain("1行目\n2行目");
  });

  it("escapes a leading markdown symbol in a decision content", () => {
    const md = renderWorkLog(baseInput({ decisions: [decisionEntry({ content: "# 偽の見出し" })] }));

    expect(md).toContain("決定: \\# 偽の見出し");
  });

  it("normalizes note", () => {
    const md = renderWorkLog(
      baseInput({ activityEvents: [activityEntry({ type: "checkin", taskTitle: null, note: "改行\nあり" })] }),
    );

    expect(md).toContain("チェックイン — 改行 あり");
  });
});
