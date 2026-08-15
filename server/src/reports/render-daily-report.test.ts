import { describe, expect, it } from "vitest";
import { FALLBACK_EVENING_SUMMARY_NOTE, renderDailyReport } from "./render-daily-report.js";
import type { RenderDailyReportInput } from "./render-daily-report.js";

function baseInput(overrides: Partial<RenderDailyReportInput> = {}): RenderDailyReportInput {
  return {
    date: new Date(2026, 7, 14), // 2026-08-14（金）
    completedTasks: [],
    inProgressTasks: [],
    firstTaskStartAt: null,
    breakCount: 0,
    breakTotalMinutes: 0,
    decisions: [],
    eveningSummary: null,
    ...overrides,
  };
}

describe("renderDailyReport — 表題・見出し", () => {
  it("renders the title with the local date and a single-kanji weekday", () => {
    const md = renderDailyReport(baseInput({ date: new Date(2026, 7, 14) })); // 金曜日

    expect(md).toContain("# 日報 2026-08-14（金）");
  });

  it.each([
    [new Date(2026, 7, 16), "日"], // 2026-08-16 は日曜
    [new Date(2026, 7, 17), "月"],
    [new Date(2026, 7, 18), "火"],
    [new Date(2026, 7, 19), "水"],
    [new Date(2026, 7, 20), "木"],
    [new Date(2026, 7, 21), "金"],
    [new Date(2026, 7, 22), "土"],
  ])("uses the correct single-kanji weekday for %s", (date, kanji) => {
    const md = renderDailyReport(baseInput({ date }));
    expect(md).toContain(`（${kanji}）`);
  });

  it("includes the section headings 本日のタスク・活動記録・夕会サマリ in this order, with no 決定事項 heading when there are no decisions", () => {
    const md = renderDailyReport(baseInput());

    const taskIdx = md.indexOf("## 本日のタスク");
    const activityIdx = md.indexOf("## 活動記録");
    const summaryIdx = md.indexOf("## 夕会サマリ");

    expect(taskIdx).toBeGreaterThan(-1);
    expect(activityIdx).toBeGreaterThan(taskIdx);
    expect(summaryIdx).toBeGreaterThan(activityIdx);
    expect(md).not.toContain("## 決定事項");
  });

  it("includes the 決定事項 heading, after 夕会サマリ, when there are decisions", () => {
    const md = renderDailyReport(baseInput({ decisions: ["資料作成を最優先にする"] }));

    const summaryIdx = md.indexOf("## 夕会サマリ");
    const decisionsIdx = md.indexOf("## 決定事項");

    expect(decisionsIdx).toBeGreaterThan(summaryIdx);
  });
});

describe("renderDailyReport — 本日のタスク", () => {
  it("renders completed tasks as '- [x] タイトル'", () => {
    const md = renderDailyReport(baseInput({ completedTasks: ["資料作成"] }));

    expect(md).toContain("- [x] 資料作成");
  });

  it("renders in-progress tasks as '- [ ] タイトル（進行中）' with a single half-width space before the checkbox content", () => {
    const md = renderDailyReport(baseInput({ inProgressTasks: ["設計レビュー"] }));

    expect(md).toContain("- [ ] 設計レビュー（進行中）");
  });

  it("lists completed tasks before in-progress tasks", () => {
    const md = renderDailyReport(
      baseInput({ completedTasks: ["タスクA"], inProgressTasks: ["タスクB"] }),
    );

    expect(md.indexOf("- [x] タスクA")).toBeLessThan(md.indexOf("- [ ] タスクB（進行中）"));
  });

  it("never emits a priority marker (⭐️)", () => {
    const md = renderDailyReport(
      baseInput({ completedTasks: ["タスクA"], inProgressTasks: ["タスクB"] }),
    );

    expect(md).not.toContain("⭐");
  });
});

describe("renderDailyReport — 活動記録", () => {
  it("renders '- 着手: なし' when there is no first task_start", () => {
    const md = renderDailyReport(baseInput({ firstTaskStartAt: null }));

    expect(md).toContain("- 着手: なし");
  });

  it("renders the HH:mm start time when there is a first task_start", () => {
    const md = renderDailyReport(
      baseInput({ firstTaskStartAt: new Date(2026, 7, 14, 9, 5) }),
    );

    expect(md).toContain("- 着手: 09:05");
  });

  it("renders '- 休憩: なし' (not '0回（合計0分）') when breakCount is 0", () => {
    const md = renderDailyReport(baseInput({ breakCount: 0, breakTotalMinutes: 0 }));

    expect(md).toContain("- 休憩: なし");
    expect(md).not.toContain("0回");
  });

  it("renders the break count and total minutes when breakCount is greater than 0", () => {
    const md = renderDailyReport(baseInput({ breakCount: 2, breakTotalMinutes: 35 }));

    expect(md).toContain("- 休憩: 2回（合計 35分）");
  });
});

describe("renderDailyReport — 夕会サマリ（通常経路）", () => {
  it("renders the three values when eveningSummary is provided", () => {
    const md = renderDailyReport(
      baseInput({
        eveningSummary: {
          reportSummary: "資料作成を完了した",
          bossComment: "よくやった",
          carryOver: "明日は設計レビューから",
        },
      }),
    );

    expect(md).toContain("- 報告の要点: 資料作成を完了した");
    expect(md).toContain("- ボスの講評: よくやった");
    expect(md).toContain("- 翌日への持ち越し: 明日は設計レビューから");
  });

  it("renders the caller-provided literal 'なし' for carryOver as-is (the renderer does not decide this fallback)", () => {
    const md = renderDailyReport(
      baseInput({
        eveningSummary: {
          reportSummary: "資料作成を完了した",
          bossComment: "よくやった",
          carryOver: "なし",
        },
      }),
    );

    expect(md).toContain("- 翌日への持ち越し: なし");
  });
});

describe("renderDailyReport — 夕会サマリ（フォールバック経路。通常経路と同じレンダラーを共用する）", () => {
  it("renders exactly the fixed one-line note and omits all three items when eveningSummary is null", () => {
    const md = renderDailyReport(baseInput({ eveningSummary: null }));

    expect(md).toContain(`- ${FALLBACK_EVENING_SUMMARY_NOTE}`);
    expect(md).not.toContain("- 報告の要点:");
    expect(md).not.toContain("- ボスの講評:");
    expect(md).not.toContain("- 翌日への持ち越し:");
  });

  it("uses the exact fixed literal text specified by the spec", () => {
    expect(FALLBACK_EVENING_SUMMARY_NOTE).toBe(
      "※ ボスの講評の生成に失敗したため、記録の機械整形で出力しています",
    );
  });
});

describe("renderDailyReport — 決定事項", () => {
  it("renders each decision content as one bullet line, in the given order (rationale is not part of the input shape)", () => {
    const md = renderDailyReport(baseInput({ decisions: ["決定1", "決定2"] }));

    expect(md.indexOf("- 決定1")).toBeLessThan(md.indexOf("- 決定2"));
  });
});

describe("renderDailyReport — 動的値のエスケープ・正規化との統合", () => {
  it("normalizes a task title containing a newline to a single line", () => {
    const md = renderDailyReport(baseInput({ completedTasks: ["1行目\n2行目"] }));

    expect(md).toContain("- [x] 1行目 2行目");
    expect(md).not.toContain("1行目\n2行目");
  });

  it("escapes a leading markdown symbol in a decision content so it cannot masquerade as a heading", () => {
    const md = renderDailyReport(baseInput({ decisions: ["# 偽の見出し"] }));

    expect(md).toContain("- \\# 偽の見出し");
    // 実際の見出しとして解釈されないこと（構造上の "## " 系見出しの並びを壊さない）
    expect(md).not.toContain("- # 偽の見出し");
  });

  it("escapes a leading markdown symbol in an evening-summary value", () => {
    const md = renderDailyReport(
      baseInput({
        eveningSummary: {
          reportSummary: "- 箇条書き風の要点",
          bossComment: "よくやった",
          carryOver: "なし",
        },
      }),
    );

    expect(md).toContain("- 報告の要点: \\- 箇条書き風の要点");
  });
});
