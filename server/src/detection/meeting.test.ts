import { describe, expect, it, vi } from "vitest";
import { buildMeetingRuleKey, isMeetingDue } from "./meeting.js";

describe("isMeetingDue", () => {
  it("fires when the meeting time has passed and no session of that type started today", () => {
    const now = new Date("2026-07-05T09:00:00");

    expect(isMeetingDue(now, "09:00", "morning", [])).toBe(true);
  });

  it("does not fire before the meeting time", () => {
    const now = new Date("2026-07-05T08:59:00");

    expect(isMeetingDue(now, "09:00", "morning", [])).toBe(false);
  });

  it("does not fire once the session type has already started today", () => {
    const now = new Date("2026-07-05T09:30:00");

    expect(isMeetingDue(now, "09:00", "morning", ["morning"])).toBe(false);
  });

  it("evaluates the evening meeting independently of the morning session", () => {
    const now = new Date("2026-07-05T18:30:00");

    expect(isMeetingDue(now, "18:00", "evening", ["morning"])).toBe(true);
  });

  it("does not fire (and warns) when the configured meeting time is malformed", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const now = new Date("2026-07-05T09:30:00");

    expect(isMeetingDue(now, "banana", "morning", [])).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("buildMeetingRuleKey", () => {
  it("builds a rule_key that includes the session type and the local date", () => {
    const now = new Date("2026-07-05T09:30:00");

    expect(buildMeetingRuleKey("morning", now)).toBe("morning_meeting:2026-07-05");
  });

  it("differs per day so the rule resets daily", () => {
    const day1 = new Date("2026-07-05T09:30:00");
    const day2 = new Date("2026-07-06T09:30:00");

    expect(buildMeetingRuleKey("morning", day1)).not.toBe(
      buildMeetingRuleKey("morning", day2),
    );
  });
});
