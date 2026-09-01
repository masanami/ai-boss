import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSettings, updateSettings } from "./settings-api";
import type { Settings } from "./settings";

const SAMPLE_SETTINGS: Settings = {
  boss_name: "ボス",
  boss_tone_preset: "reliable",
  boss_strictness: 3,
  boss_custom_instructions: null,
  work_start: "09:00",
  work_end: "18:00",
  morning_meeting_time: "09:00",
  evening_meeting_time: "18:00",
  detection_unstarted_fallback_minutes: 60,
  detection_silence_fallback_minutes: 45,
  detection_break_fallback_minutes: 15,
  escalation_l2_after_minutes: 15,
  escalation_l3_after_minutes: 10,
  escalation_repeat_minutes: 10,
  model: "claude-sonnet-5",
};

describe("fetchSettings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed settings when the request succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SETTINGS),
    });
    vi.stubGlobal("fetch", fetchMock);

    const settings = await fetchSettings();

    expect(settings).toEqual(SAMPLE_SETTINGS);
    expect(fetchMock).toHaveBeenCalledWith("/api/settings");
  });

  it("throws with the server error message when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "internal error" }),
      }),
    );

    await expect(fetchSettings()).rejects.toThrow("internal error");
  });
});

describe("updateSettings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUTs the patch with correct key names and value types and returns the updated settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SETTINGS),
    });
    vi.stubGlobal("fetch", fetchMock);

    const patch = {
      boss_name: "鬼上司",
      boss_tone_preset: "strict" as const,
      boss_strictness: 5,
      detection_unstarted_fallback_minutes: 30,
      escalation_repeat_minutes: 10,
    };

    const updated = await updateSettings(patch);

    expect(updated).toEqual(SAMPLE_SETTINGS);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
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
          Promise.resolve({ error: "boss_strictness must be an integer between 1 and 5" }),
      }),
    );

    await expect(
      updateSettings({ boss_strictness: 99 }),
    ).rejects.toThrow("boss_strictness must be an integer between 1 and 5");
  });
});
