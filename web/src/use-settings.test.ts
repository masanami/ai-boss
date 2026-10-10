import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSettings } from "./use-settings";
import type { Settings, SettingsWarning } from "./settings";

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
  detection_daily_notification_cap: 5,
  model: "claude-sonnet-5",
  evidence_enforcement_enabled: false,
  morning_mentoring_required: true,
};

describe("useSettings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads settings on mount and sets status ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE_SETTINGS),
      }),
    );

    const { result } = renderHook(() => useSettings());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.settings).toEqual(SAMPLE_SETTINGS);
  });

  it("sets an error status when the initial fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    const { result } = renderHook(() => useSettings());

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.settings).toBeNull();
  });

  it("updates settings and returns true after a successful save", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SETTINGS),
    });
    const updated = { ...SAMPLE_SETTINGS, boss_name: "鬼上司" };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ settings: updated, warnings: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let saved = false;
    await act(async () => {
      saved = await result.current.saveSettings({ boss_name: "鬼上司" });
    });

    expect(saved).toBe(true);
    expect(result.current.settings).toEqual(updated);
    expect(result.current.saveError).toBeNull();
  });

  it("sets saveError and returns false when the save fails, keeping the previous settings", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SETTINGS),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({ error: "boss_strictness must be an integer between 1 and 5" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let saved = true;
    await act(async () => {
      saved = await result.current.saveSettings({ boss_strictness: 99 });
    });

    expect(saved).toBe(false);
    expect(result.current.saveError).toBe(
      "boss_strictness must be an integer between 1 and 5",
    );
    expect(result.current.settings).toEqual(SAMPLE_SETTINGS);
  });

  it("sets isSaving true while a save is in flight", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SETTINGS),
    });
    let releaseSave: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSave = () =>
            resolve({
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({ settings: SAMPLE_SETTINGS, warnings: [] }),
            });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let savePromise: Promise<boolean> | undefined;
    act(() => {
      savePromise = result.current.saveSettings({ boss_name: "鬼上司" });
    });

    await waitFor(() => expect(result.current.isSaving).toBe(true));

    await act(async () => {
      releaseSave?.();
      await savePromise;
    });

    expect(result.current.isSaving).toBe(false);
  });
  // #708 決定 18・22: 警告は設定とは別の状態に置き、保存のたびに置き換える。
  describe("saveWarnings (#708)", () => {
    const WARNING: SettingsWarning = {
      code: "meeting_outside_working_hours",
      key: "morning_meeting_time",
      message: "朝会の時刻（08:30）が勤務時間帯（09:00〜18:00）の外にあります",
    };
    const OUTSIDE = { ...SAMPLE_SETTINGS, morning_meeting_time: "08:30" };

    function okGet() {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE_SETTINGS),
      };
    }

    function okPut(settings: Settings, warnings: SettingsWarning[]) {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ settings, warnings }),
      };
    }

    it("is empty before any save", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(okGet()));

      const { result } = renderHook(() => useSettings());
      await waitFor(() => expect(result.current.status).toBe("ready"));

      expect(result.current.saveWarnings).toEqual([]);
    });

    it("keeps the response's settings as settings and its warnings separately", async () => {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(okGet());
      fetchMock.mockResolvedValueOnce(okPut(OUTSIDE, [WARNING]));
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useSettings());
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => {
        await result.current.saveSettings(OUTSIDE);
      });

      expect(result.current.settings).toEqual(OUTSIDE);
      expect(result.current.saveWarnings).toEqual([WARNING]);
    });

    it("clears the previous warnings as soon as the next save starts", async () => {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(okGet());
      fetchMock.mockResolvedValueOnce(okPut(OUTSIDE, [WARNING]));
      let releaseSave: (() => void) | undefined;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSave = () => resolve(okPut(OUTSIDE, [WARNING]));
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useSettings());
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => {
        await result.current.saveSettings(OUTSIDE);
      });
      expect(result.current.saveWarnings).toEqual([WARNING]);

      let savePromise: Promise<boolean> | undefined;
      act(() => {
        savePromise = result.current.saveSettings(OUTSIDE);
      });
      await waitFor(() => expect(result.current.isSaving).toBe(true));
      expect(result.current.saveWarnings).toEqual([]);

      await act(async () => {
        releaseSave?.();
        await savePromise;
      });
      expect(result.current.saveWarnings).toEqual([WARNING]);
    });

    it("clears the previous warnings when the next save fails", async () => {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(okGet());
      fetchMock.mockResolvedValueOnce(okPut(OUTSIDE, [WARNING]));
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "invalid" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useSettings());
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => {
        await result.current.saveSettings(OUTSIDE);
      });
      await act(async () => {
        await result.current.saveSettings(OUTSIDE);
      });

      expect(result.current.saveError).toBe("invalid");
      expect(result.current.saveWarnings).toEqual([]);
    });
  });
});
