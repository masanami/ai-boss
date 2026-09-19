import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMeetingSchedule, updateMeetingSchedule } from "./meeting-schedule-api";
import type { MeetingScheduleResponse } from "./meeting-schedule";

const SAMPLE_SCHEDULE: MeetingScheduleResponse = {
  date: "2026-09-20",
  morning: {
    time: "09:00",
    defaultTime: "09:00",
    overridden: false,
    latestAllowedTime: "12:00",
  },
  evening: {
    time: "21:00",
    defaultTime: "18:00",
    overridden: true,
    latestAllowedTime: "21:00",
  },
};

describe("fetchMeetingSchedule", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs the schedule for the given date and returns the parsed body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SCHEDULE),
    });
    vi.stubGlobal("fetch", fetchMock);

    const schedule = await fetchMeetingSchedule("2026-09-20");

    expect(schedule).toEqual(SAMPLE_SCHEDULE);
    expect(fetchMock).toHaveBeenCalledWith("/api/meeting-schedule/2026-09-20");
  });

  it("throws with the server error message when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "date には今日の日付を指定してください", code: "not_today" }),
      }),
    );

    await expect(fetchMeetingSchedule("2026-09-19")).rejects.toThrow(
      "date には今日の日付を指定してください",
    );
  });
});

describe("updateMeetingSchedule", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUTs the patch to the date-scoped URL and returns the updated schedule", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SCHEDULE),
    });
    vi.stubGlobal("fetch", fetchMock);

    const patch = { morning: "10:00", evening: null };
    const updated = await updateMeetingSchedule("2026-09-20", patch);

    expect(updated).toEqual(SAMPLE_SCHEDULE);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/meeting-schedule/2026-09-20",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  });

  it("throws with the server error message when the update fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({ error: "夕会の時刻は 21:00 より後には設定できません", code: "delay_limit_exceeded" }),
      }),
    );

    await expect(
      updateMeetingSchedule("2026-09-20", { evening: "23:00" }),
    ).rejects.toThrow("夕会の時刻は 21:00 より後には設定できません");
  });
});
