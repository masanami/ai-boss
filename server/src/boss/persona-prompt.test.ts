import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONA_SETTINGS,
  buildPersonaPrompt,
  type PersonaSettings,
} from "./persona-prompt.js";
import type { Task } from "../tasks/task.js";

const now = new Date("2026-07-05T10:00:00+09:00");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "資料作成",
    description: null,
    category: "work",
    priority: "high",
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
    created_at: "2026-07-05T00:00:00+09:00",
    updated_at: "2026-07-05T00:00:00+09:00",
    completed_at: null,
    ...overrides,
  };
}

describe("buildPersonaPrompt", () => {
  it("常に「決定の形で断言する」規律を含む", () => {
    const prompt = buildPersonaPrompt(DEFAULT_PERSONA_SETTINGS, {
      tasks: [],
      recentDecisions: [],
      now,
    });

    expect(prompt).toContain("決定の形で断言する");
  });

  it("既定プリセット「信頼できる上司」は穏やか・合理的で、過剰な賞賛を禁止する文言を含む", () => {
    const prompt = buildPersonaPrompt(DEFAULT_PERSONA_SETTINGS, {
      tasks: [],
      recentDecisions: [],
      now,
    });

    expect(prompt).toContain("穏やか");
    expect(prompt).toContain("合理的");
    expect(prompt).toContain("過剰");
  });

  it("tone: strict は厳格な文言を含み、reliable 固有の文言は含まない", () => {
    const settings: PersonaSettings = { ...DEFAULT_PERSONA_SETTINGS, tone: "strict" };
    const prompt = buildPersonaPrompt(settings, { tasks: [], recentDecisions: [], now });

    expect(prompt).toContain("厳格");
    expect(prompt).not.toContain("穏やかで合理的");
  });

  it("tone: logical はロジカルな文言を含む", () => {
    const settings: PersonaSettings = { ...DEFAULT_PERSONA_SETTINGS, tone: "logical" };
    const prompt = buildPersonaPrompt(settings, { tasks: [], recentDecisions: [], now });

    expect(prompt).toContain("ロジカル");
  });

  it("tone: passionate は熱血な文言を含む", () => {
    const settings: PersonaSettings = { ...DEFAULT_PERSONA_SETTINGS, tone: "passionate" };
    const prompt = buildPersonaPrompt(settings, { tasks: [], recentDecisions: [], now });

    expect(prompt).toContain("熱血");
  });

  it("厳しさレベルが異なると説明文言も異なる", () => {
    const low = buildPersonaPrompt(
      { ...DEFAULT_PERSONA_SETTINGS, strictness: 1 },
      { tasks: [], recentDecisions: [], now },
    );
    const high = buildPersonaPrompt(
      { ...DEFAULT_PERSONA_SETTINGS, strictness: 5 },
      { tasks: [], recentDecisions: [], now },
    );

    expect(low).toContain("とても緩やか");
    expect(high).toContain("非常に厳しい");
    expect(low).not.toBe(high);
  });

  it("厳しさレベルが範囲外（1..5 の外）でも \"undefined\" を出力せず、既定レベルの説明にフォールバックする", () => {
    const tooLow = buildPersonaPrompt(
      { ...DEFAULT_PERSONA_SETTINGS, strictness: 0 },
      { tasks: [], recentDecisions: [], now },
    );
    const tooHigh = buildPersonaPrompt(
      { ...DEFAULT_PERSONA_SETTINGS, strictness: 6 },
      { tasks: [], recentDecisions: [], now },
    );

    expect(tooLow).not.toContain("undefined");
    expect(tooHigh).not.toContain("undefined");
    expect(tooLow).toContain("厳しさレベル 3");
    expect(tooHigh).toContain("厳しさレベル 3");
  });

  it("customInstructions が設定されていればプロンプトに含まれる", () => {
    const settings: PersonaSettings = {
      ...DEFAULT_PERSONA_SETTINGS,
      customInstructions: "語尾に「〜だ」をつけること",
    };
    const prompt = buildPersonaPrompt(settings, { tasks: [], recentDecisions: [], now });

    expect(prompt).toContain("語尾に「〜だ」をつけること");
  });

  it("customInstructions が null なら追加指示セクションを含まない", () => {
    const prompt = buildPersonaPrompt(DEFAULT_PERSONA_SETTINGS, {
      tasks: [],
      recentDecisions: [],
      now,
    });

    expect(prompt).not.toContain("追加指示");
  });

  it("name がプロンプトに反映される", () => {
    const settings: PersonaSettings = { ...DEFAULT_PERSONA_SETTINGS, name: "スミス" };
    const prompt = buildPersonaPrompt(settings, { tasks: [], recentDecisions: [], now });

    expect(prompt).toContain("スミス");
  });

  it("タスクが空のとき、タスクなしの文言を含む", () => {
    const prompt = buildPersonaPrompt(DEFAULT_PERSONA_SETTINGS, {
      tasks: [],
      recentDecisions: [],
      now,
    });

    expect(prompt).toContain("現在登録されているタスクはありません");
  });

  it("タスクがあるとき、タスクのタイトルがプロンプトに含まれる", () => {
    const prompt = buildPersonaPrompt(DEFAULT_PERSONA_SETTINGS, {
      tasks: [makeTask({ title: "資料作成" })],
      recentDecisions: [],
      now,
    });

    expect(prompt).toContain("資料作成");
  });

  it("直近の決定が空のとき、決定なしの文言を含む", () => {
    const prompt = buildPersonaPrompt(DEFAULT_PERSONA_SETTINGS, {
      tasks: [],
      recentDecisions: [],
      now,
    });

    expect(prompt).toContain("直近の決定はまだありません");
  });

  it("直近の決定があるとき、その内容がプロンプトに含まれる", () => {
    const prompt = buildPersonaPrompt(DEFAULT_PERSONA_SETTINGS, {
      tasks: [],
      recentDecisions: [{ content: "A案件を最優先にする", decidedAt: "2026-07-05T09:00:00+09:00" }],
      now,
    });

    expect(prompt).toContain("A案件を最優先にする");
  });

  it.each([
    [4, "夜"],
    [5, "朝"],
    [8, "朝"],
    [9, "朝"],
    [10, "日中"],
    [13, "日中"],
    [16, "日中"],
    [17, "夕方"],
    [18, "夕方"],
    [19, "夕方"],
    [20, "夜"],
    [22, "夜"],
  ])("%i時なら時間帯ヒント「%s」を含む", (hour, expectedLabel) => {
    const at = new Date("2026-07-05T00:00:00+09:00");
    at.setHours(hour, 0, 0, 0);

    const prompt = buildPersonaPrompt(DEFAULT_PERSONA_SETTINGS, {
      tasks: [],
      recentDecisions: [],
      now: at,
    });

    expect(prompt).toContain(expectedLabel);
  });

  it("purpose 省略時（chat）は通知向けの短文指示を含まない", () => {
    const prompt = buildPersonaPrompt(DEFAULT_PERSONA_SETTINGS, {
      tasks: [],
      recentDecisions: [],
      now,
    });

    expect(prompt).not.toContain("通知文面として使われる");
  });

  it("purpose が notification のとき、短文指示を含む", () => {
    const prompt = buildPersonaPrompt(DEFAULT_PERSONA_SETTINGS, {
      tasks: [],
      recentDecisions: [],
      now,
      purpose: "notification",
    });

    expect(prompt).toContain("通知文面として使われる");
  });
});
