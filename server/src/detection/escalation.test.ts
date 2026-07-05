import { describe, expect, it } from "vitest";
import { resolveEscalation } from "./escalation.js";
import { DEFAULT_DETECTION_SETTINGS } from "./detection-types.js";
import { makeActivityEvent } from "./detection-test-fixtures.js";

const escalationSettings = DEFAULT_DETECTION_SETTINGS.escalation;

describe("resolveEscalation", () => {
  it("fires at level 1 when there is no notification history", () => {
    const now = new Date("2026-07-05T10:00:00.000Z");

    const result = resolveEscalation("unstarted:1", now, [], [], escalationSettings);

    expect(result).toEqual({ escalationLevel: 1 });
  });

  it("does not re-fire before the level-1-to-2 interval (15min) has elapsed", () => {
    const lastSentAt = "2026-07-05T10:00:00.000Z";
    const now = new Date("2026-07-05T10:14:59.000Z");
    const notifications = [{ ruleKey: "unstarted:1", escalationLevel: 1, sentAt: lastSentAt }];

    const result = resolveEscalation("unstarted:1", now, notifications, [], escalationSettings);

    expect(result).toBeNull();
  });

  it("escalates from level 1 to level 2 exactly at the 15min interval", () => {
    const lastSentAt = "2026-07-05T10:00:00.000Z";
    const now = new Date("2026-07-05T10:15:00.000Z");
    const notifications = [{ ruleKey: "unstarted:1", escalationLevel: 1, sentAt: lastSentAt }];

    const result = resolveEscalation("unstarted:1", now, notifications, [], escalationSettings);

    expect(result).toEqual({ escalationLevel: 2 });
  });

  it("escalates from level 2 to level 3 after the 10min interval", () => {
    const lastSentAt = "2026-07-05T10:00:00.000Z";
    const now = new Date("2026-07-05T10:10:00.000Z");
    const notifications = [{ ruleKey: "unstarted:1", escalationLevel: 2, sentAt: lastSentAt }];

    const result = resolveEscalation("unstarted:1", now, notifications, [], escalationSettings);

    expect(result).toEqual({ escalationLevel: 3 });
  });

  it("caps at level 3 and repeats at the 10min interval", () => {
    const lastSentAt = "2026-07-05T10:00:00.000Z";
    const now = new Date("2026-07-05T10:10:00.000Z");
    const notifications = [{ ruleKey: "unstarted:1", escalationLevel: 3, sentAt: lastSentAt }];

    const result = resolveEscalation("unstarted:1", now, notifications, [], escalationSettings);

    expect(result).toEqual({ escalationLevel: 3 });
  });

  it("resets to level 1 and fires immediately when an activity signal occurred after the last notification", () => {
    const lastSentAt = "2026-07-05T10:00:00.000Z";
    const now = new Date("2026-07-05T10:05:00.000Z");
    const notifications = [{ ruleKey: "unstarted:1", escalationLevel: 2, sentAt: lastSentAt }];
    const activityEvents = [
      makeActivityEvent({ type: "task_start", created_at: "2026-07-05T10:02:00.000Z" }),
    ];

    const result = resolveEscalation(
      "unstarted:1",
      now,
      notifications,
      activityEvents,
      escalationSettings,
    );

    expect(result).toEqual({ escalationLevel: 1 });
  });

  it("ignores activity that happened before the last notification (does not reset)", () => {
    const lastSentAt = "2026-07-05T10:00:00.000Z";
    const now = new Date("2026-07-05T10:05:00.000Z");
    const notifications = [{ ruleKey: "unstarted:1", escalationLevel: 2, sentAt: lastSentAt }];
    const activityEvents = [
      makeActivityEvent({ type: "task_start", created_at: "2026-07-05T09:00:00.000Z" }),
    ];

    const result = resolveEscalation(
      "unstarted:1",
      now,
      notifications,
      activityEvents,
      escalationSettings,
    );

    expect(result).toBeNull();
  });

  it("only considers history for the matching rule_key", () => {
    const now = new Date("2026-07-05T10:00:00.000Z");
    const notifications = [
      { ruleKey: "unstarted:2", escalationLevel: 3, sentAt: "2026-07-05T09:00:00.000Z" },
    ];

    const result = resolveEscalation("unstarted:1", now, notifications, [], escalationSettings);

    expect(result).toEqual({ escalationLevel: 1 });
  });

  it("uses the most recent entry when multiple history rows exist for the same rule_key", () => {
    const now = new Date("2026-07-05T10:10:00.000Z");
    const notifications = [
      { ruleKey: "unstarted:1", escalationLevel: 1, sentAt: "2026-07-05T09:00:00.000Z" },
      { ruleKey: "unstarted:1", escalationLevel: 2, sentAt: "2026-07-05T10:00:00.000Z" },
    ];

    const result = resolveEscalation("unstarted:1", now, notifications, [], escalationSettings);

    expect(result).toEqual({ escalationLevel: 3 });
  });
});
