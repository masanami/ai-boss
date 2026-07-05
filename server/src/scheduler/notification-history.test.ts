import { describe, expect, it } from "vitest";
import type { Notification } from "../notifications/notification.js";
import { toNotificationHistory } from "./notification-history.js";

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    type: "escalation",
    rule_key: "unstarted:1",
    escalation_level: 1,
    body: "着手しろ",
    sent_at: "2026-07-05T10:00:00.000Z",
    ...overrides,
  };
}

describe("toNotificationHistory", () => {
  it("converts snake_case DB rows into the camelCase shape the rule engine expects", () => {
    const rows = [
      makeNotification({ rule_key: "unstarted:1", escalation_level: 2, sent_at: "2026-07-05T11:00:00.000Z" }),
    ];

    expect(toNotificationHistory(rows)).toEqual([
      { ruleKey: "unstarted:1", escalationLevel: 2, sentAt: "2026-07-05T11:00:00.000Z" },
    ]);
  });

  it("drops rows with a null rule_key (cannot be matched by any rule_key-scoped lookup)", () => {
    const rows = [
      makeNotification({ rule_key: null }),
      makeNotification({ rule_key: "unstarted:1" }),
    ];

    expect(toNotificationHistory(rows)).toEqual([
      { ruleKey: "unstarted:1", escalationLevel: 1, sentAt: "2026-07-05T10:00:00.000Z" },
    ]);
  });

  it("drops rows with a null escalation_level", () => {
    const rows = [makeNotification({ escalation_level: null })];

    expect(toNotificationHistory(rows)).toEqual([]);
  });

  it("returns an empty array for an empty input", () => {
    expect(toNotificationHistory([])).toEqual([]);
  });
});
