import { describe, expect, it } from "vitest";
import { mapToNotificationRuleType, toEscalationLevel } from "./rule-type-mapping.js";

describe("mapToNotificationRuleType", () => {
  it("maps unstarted to todo_stall (naming drifted between #36 and #37)", () => {
    expect(mapToNotificationRuleType("unstarted")).toBe("todo_stall");
  });

  it("passes through rule types shared by the detection engine and notification-body unchanged", () => {
    expect(mapToNotificationRuleType("avoidance")).toBe("avoidance");
    expect(mapToNotificationRuleType("break_overrun")).toBe("break_overrun");
    expect(mapToNotificationRuleType("silence")).toBe("silence");
  });

  it("maps the deadline/meeting rule types added for the scheduler integration", () => {
    expect(mapToNotificationRuleType("deadline_overdue")).toBe("deadline_overdue");
    expect(mapToNotificationRuleType("morning_meeting")).toBe("morning_meeting");
    expect(mapToNotificationRuleType("evening_meeting")).toBe("evening_meeting");
  });
});

describe("toEscalationLevel", () => {
  it("passes through the known levels 1, 2, 3 unchanged", () => {
    expect(toEscalationLevel(1)).toBe(1);
    expect(toEscalationLevel(2)).toBe(2);
    expect(toEscalationLevel(3)).toBe(3);
  });

  it("clamps levels below 1 up to 1", () => {
    expect(toEscalationLevel(0)).toBe(1);
  });

  it("clamps levels above 3 down to 3", () => {
    expect(toEscalationLevel(4)).toBe(3);
  });
});
