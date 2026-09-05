import { describe, expect, it } from "vitest";
import { validateCheckinInput } from "./checkins-validation.js";

describe("validateCheckinInput", () => {
  it("accepts a checkin with only a type", () => {
    const result = validateCheckinInput({ type: "checkin" });

    expect(result).toEqual({
      valid: true,
      data: {
        type: "checkin",
        task_id: null,
        note: null,
        expected_minutes: null,
        occurred_at: null,
      },
    });
  });

  it("accepts break_end with only a type", () => {
    const result = validateCheckinInput({ type: "break_end" });

    expect(result.valid).toBe(true);
  });

  it("rejects a body that is not a JSON object", () => {
    const result = validateCheckinInput("not an object");

    expect(result.valid).toBe(false);
  });

  it("rejects a missing type", () => {
    const result = validateCheckinInput({});

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("type");
    }
  });

  it("rejects an invalid type (e.g. an auto-recorded-only type)", () => {
    const result = validateCheckinInput({ type: "task_update" });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("type");
    }
  });

  describe("task_start", () => {
    it("accepts task_start with a task_id", () => {
      const result = validateCheckinInput({ type: "task_start", task_id: 1 });

      expect(result).toEqual({
        valid: true,
        data: {
          type: "task_start",
          task_id: 1,
          note: null,
          expected_minutes: null,
          occurred_at: null,
        },
      });
    });

    it("rejects task_start without a task_id", () => {
      const result = validateCheckinInput({ type: "task_start" });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("task_id");
      }
    });

    it("rejects task_start with a non-numeric task_id", () => {
      const result = validateCheckinInput({
        type: "task_start",
        task_id: "1",
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("task_id");
      }
    });
  });

  describe("task_pause", () => {
    it("accepts task_pause with a task_id", () => {
      const result = validateCheckinInput({ type: "task_pause", task_id: 1 });

      expect(result).toEqual({
        valid: true,
        data: {
          type: "task_pause",
          task_id: 1,
          note: null,
          expected_minutes: null,
          occurred_at: null,
        },
      });
    });

    it("rejects task_pause without a task_id", () => {
      const result = validateCheckinInput({ type: "task_pause" });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("task_id");
      }
    });

    it("rejects task_pause with a non-numeric task_id", () => {
      const result = validateCheckinInput({
        type: "task_pause",
        task_id: "1",
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("task_id");
      }
    });

    it("rejects task_pause with an explicit null task_id", () => {
      const result = validateCheckinInput({ type: "task_pause", task_id: null });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("task_id");
      }
    });
  });

  describe("task_id on non-task_start types", () => {
    it("accepts an explicit null task_id (task_id is number | null)", () => {
      const result = validateCheckinInput({ type: "checkin", task_id: null });

      expect(result).toEqual({
        valid: true,
        data: {
          type: "checkin",
          task_id: null,
          note: null,
          expected_minutes: null,
          occurred_at: null,
        },
      });
    });

    it("accepts an explicit null task_id for break_end", () => {
      const result = validateCheckinInput({ type: "break_end", task_id: null });

      expect(result).toEqual({
        valid: true,
        data: {
          type: "break_end",
          task_id: null,
          note: null,
          expected_minutes: null,
          occurred_at: null,
        },
      });
    });

    it("still rejects a non-numeric, non-null task_id", () => {
      const result = validateCheckinInput({ type: "checkin", task_id: "1" });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("task_id");
      }
    });

    it("still rejects task_start with an explicit null task_id", () => {
      const result = validateCheckinInput({ type: "task_start", task_id: null });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("task_id");
      }
    });
  });

  describe("break_start expected_minutes", () => {
    it("accepts break_start with a positive integer expected_minutes", () => {
      const result = validateCheckinInput({
        type: "break_start",
        expected_minutes: 15,
      });

      expect(result).toEqual({
        valid: true,
        data: {
          type: "break_start",
          task_id: null,
          note: null,
          expected_minutes: 15,
          occurred_at: null,
        },
      });
    });

    it("defaults expected_minutes to null when omitted", () => {
      const result = validateCheckinInput({ type: "break_start" });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.expected_minutes).toBeNull();
      }
    });

    it.each([0, -5, 1.5, "15"])(
      "rejects a non-positive-integer expected_minutes: %s",
      (invalid) => {
        const result = validateCheckinInput({
          type: "break_start",
          expected_minutes: invalid,
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.error).toContain("expected_minutes");
        }
      },
    );
  });

  describe("note", () => {
    it("accepts an optional note string", () => {
      const result = validateCheckinInput({
        type: "checkin",
        note: "進捗確認です",
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.note).toBe("進捗確認です");
      }
    });

    it("rejects a non-string note", () => {
      const result = validateCheckinInput({ type: "checkin", note: 42 });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("note");
      }
    });
  });

  describe("occurred_at", () => {
    it("accepts a valid ISO 8601 date-time occurred_at (AC-1)", () => {
      const result = validateCheckinInput({
        type: "checkin",
        occurred_at: "2026-07-05T09:00:00.000Z",
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.occurred_at).toBe("2026-07-05T09:00:00.000Z");
      }
    });

    it("defaults occurred_at to null when omitted (AC-2)", () => {
      const result = validateCheckinInput({ type: "checkin" });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.occurred_at).toBeNull();
      }
    });

    it("treats an explicit null occurred_at as omitted (AC-2)", () => {
      const result = validateCheckinInput({
        type: "checkin",
        occurred_at: null,
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.occurred_at).toBeNull();
      }
    });

    it("rejects a date-only occurred_at (YYYY-MM-DD) (AC-3)", () => {
      const result = validateCheckinInput({
        type: "checkin",
        occurred_at: "2026-07-05",
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("occurred_at");
      }
    });

    it("rejects a non-string occurred_at (AC-3)", () => {
      const result = validateCheckinInput({
        type: "checkin",
        occurred_at: 12345,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("occurred_at");
      }
    });

    it("rejects an occurred_at that is not a valid ISO 8601 string (AC-3)", () => {
      const result = validateCheckinInput({
        type: "checkin",
        occurred_at: "not-a-date",
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("occurred_at");
      }
    });

    it("rejects an occurred_at with a non-existent calendar date (AC-3)", () => {
      const result = validateCheckinInput({
        type: "checkin",
        occurred_at: "2026-02-30T09:00:00.000Z",
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("occurred_at");
      }
    });
  });
});
