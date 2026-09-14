import { describe, expect, it } from "vitest";
import {
  buildCommitmentMissedRuleKey,
  findMissedCommitmentTasks,
  hasMissedCommitment,
  hasNoHistoryForRuleKey,
} from "./commitment-missed.js";
import { makeTask } from "./detection-test-fixtures.js";

// 固定時刻はすべて new Date(2026, 8, 14, h, min) から導出する（ADR 0007 決定 5・
// 機能仕様 docs/features/task-start-commitment.md「受入基準」冒頭の運用）。
const COMMITTED_AT_INSTANT = new Date(2026, 8, 14, 14, 0);
const COMMITTED_START_AT = COMMITTED_AT_INSTANT.toISOString();

describe("hasMissedCommitment", () => {
  it("is true for a todo task exactly at its committed start time (grace period is 0 minutes)", () => {
    const task = makeTask({ status: "todo", committed_start_at: COMMITTED_START_AT, committed_at: "2026-07-05T00:00:00.000Z" });

    expect(hasMissedCommitment(task, new Date(2026, 8, 14, 14, 0))).toBe(true);
  });

  // 変異: 発火条件の `now >= 約束` を `now > 約束` にする — この入力で発火しなくなる
  it("is false one minute before the committed start time", () => {
    const task = makeTask({ status: "todo", committed_start_at: COMMITTED_START_AT, committed_at: "2026-07-05T00:00:00.000Z" });

    expect(hasMissedCommitment(task, new Date(2026, 8, 14, 13, 59))).toBe(false);
  });

  it.each(["in_progress", "paused", "done", "dropped"] as const)(
    "is false for a %s task even past its committed start time",
    (status) => {
      const task = makeTask({ status, committed_start_at: COMMITTED_START_AT, committed_at: "2026-07-05T00:00:00.000Z" });

      expect(hasMissedCommitment(task, new Date(2026, 8, 14, 14, 30))).toBe(false);
    },
  );

  it("is false for a todo task with no commitment", () => {
    const task = makeTask({ status: "todo", committed_start_at: null, committed_at: null });

    expect(hasMissedCommitment(task, new Date(2026, 8, 14, 14, 30))).toBe(false);
  });
});

describe("findMissedCommitmentTasks", () => {
  it("returns every task with a missed commitment regardless of priority (evaluates all, like findOverdueTasks)", () => {
    const highNoCommitment = makeTask({
      id: 1,
      priority: "high",
      status: "in_progress",
      committed_start_at: null,
      committed_at: null,
    });
    const lowMissed = makeTask({
      id: 2,
      priority: "low",
      status: "todo",
      committed_start_at: COMMITTED_START_AT,
      committed_at: "2026-07-05T00:00:00.000Z",
    });

    const result = findMissedCommitmentTasks(
      [highNoCommitment, lowMissed],
      new Date(2026, 8, 14, 14, 30),
    );

    expect(result).toEqual([lowMissed]);
  });
});

describe("buildCommitmentMissedRuleKey", () => {
  it("includes taskId, committed_start_at, and committed_at (in that order)", () => {
    const task = makeTask({
      id: 7,
      committed_start_at: new Date(2026, 8, 14, 14, 0).toISOString(),
      committed_at: new Date(2026, 8, 14, 9, 30).toISOString(),
    });

    expect(buildCommitmentMissedRuleKey(task)).toBe(
      `commitment_missed:7:${new Date(2026, 8, 14, 14, 0).toISOString()}:${new Date(2026, 8, 14, 9, 30).toISOString()}`,
    );
  });

  // 変異: ruleKey から committed_at を外す — 末尾の committed_at が欠けて
  // 別インスタンスの約束と衝突しうる形になる
  it("produces a different rule_key when only committed_at differs (same committed_start_at)", () => {
    const first = makeTask({
      id: 7,
      committed_start_at: COMMITTED_START_AT,
      committed_at: "2026-09-14T00:00:00.000Z",
    });
    const second = makeTask({
      id: 7,
      committed_start_at: COMMITTED_START_AT,
      committed_at: "2026-09-14T05:00:00.000Z",
    });

    expect(buildCommitmentMissedRuleKey(first)).not.toBe(buildCommitmentMissedRuleKey(second));
  });
});

describe("hasNoHistoryForRuleKey", () => {
  it("is true when no notification history entry matches the rule_key", () => {
    expect(hasNoHistoryForRuleKey("commitment_missed:1:a:b", [])).toBe(true);
  });

  it("is false when a notification history entry matches the rule_key", () => {
    const notifications = [
      { ruleKey: "commitment_missed:1:a:b", escalationLevel: 1, sentAt: "2026-09-14T11:00:00.000Z" },
    ];

    expect(hasNoHistoryForRuleKey("commitment_missed:1:a:b", notifications)).toBe(false);
  });

  it("is true when history entries exist but for a different rule_key", () => {
    const notifications = [
      { ruleKey: "commitment_missed:1:a:different", escalationLevel: 1, sentAt: "2026-09-14T11:00:00.000Z" },
    ];

    expect(hasNoHistoryForRuleKey("commitment_missed:1:a:b", notifications)).toBe(true);
  });
});
