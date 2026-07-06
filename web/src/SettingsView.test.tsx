import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsView from "./SettingsView";
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

/**
 * Queues exactly one resolved GET response (the initial mount fetch) on a
 * fresh mock, with no default beyond it — every later call (e.g. the save's
 * PUT) must be queued explicitly by the test via `mockResolvedValueOnce` /
 * `mockImplementationOnce` so it isn't accidentally consumed by the mount
 * fetch instead.
 */
function stubGet(settings: Settings = SAMPLE_SETTINGS) {
  const fetchMock = vi.fn();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve(settings),
  });
  return fetchMock;
}

describe("SettingsView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading indicator while settings are loading", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<SettingsView />);

    expect(screen.getByText("読み込み中…")).toBeInTheDocument();
  });

  it("shows an error message when loading settings fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    render(<SettingsView />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "設定の取得に失敗しました",
      ),
    );
  });

  it("renders the loaded settings values in the form fields", async () => {
    vi.stubGlobal("fetch", stubGet());

    render(<SettingsView />);

    await waitFor(() =>
      expect(screen.getByLabelText("ボスの名前")).toHaveValue("ボス"),
    );
    expect(screen.getByLabelText("口調プリセット")).toHaveValue("reliable");
    expect(screen.getByLabelText("厳しさ")).toHaveValue("3");
    expect(screen.getByLabelText("追加の指示")).toHaveValue("");
    expect(screen.getByLabelText("朝会の時刻")).toHaveValue("09:00");
    expect(screen.getByLabelText("夕会の時刻")).toHaveValue("18:00");
    expect(screen.getByLabelText("勤務開始")).toHaveValue("09:00");
    expect(screen.getByLabelText("勤務終了")).toHaveValue("18:00");
    expect(screen.getByLabelText("未着手のフォールバック（分）")).toHaveValue(
      60,
    );
    expect(screen.getByLabelText("無音のフォールバック（分）")).toHaveValue(
      45,
    );
    expect(screen.getByLabelText("休憩のフォールバック（分）")).toHaveValue(
      15,
    );
    expect(
      screen.getByLabelText("エスカレーション: レベル2まで（分）"),
    ).toHaveValue(15);
    expect(
      screen.getByLabelText("エスカレーション: レベル3まで（分）"),
    ).toHaveValue(10);
    expect(
      screen.getByLabelText("エスカレーション: 再通知間隔（分）"),
    ).toHaveValue(10);
    expect(screen.getByLabelText("モデル")).toHaveValue("claude-sonnet-5");
  });

  it("submits the current form values with correct key names and value types when saved without edits", async () => {
    const fetchMock = stubGet();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SETTINGS),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsView />);
    await waitFor(() =>
      expect(screen.getByLabelText("ボスの名前")).toHaveValue("ボス"),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boss_name: "ボス",
          boss_tone_preset: "reliable",
          boss_strictness: 3,
          boss_custom_instructions: "",
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
        }),
      }),
    );
  });

  it("submits edited values with the correct types (numbers stay numbers)", async () => {
    const fetchMock = stubGet();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ...SAMPLE_SETTINGS, boss_name: "鬼上司" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsView />);
    await waitFor(() =>
      expect(screen.getByLabelText("ボスの名前")).toHaveValue("ボス"),
    );

    fireEvent.change(screen.getByLabelText("ボスの名前"), {
      target: { value: "鬼上司" },
    });
    fireEvent.change(screen.getByLabelText("口調プリセット"), {
      target: { value: "strict" },
    });
    fireEvent.change(screen.getByLabelText("厳しさ"), {
      target: { value: "5" },
    });
    fireEvent.change(
      screen.getByLabelText("未着手のフォールバック（分）"),
      { target: { value: "30" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    const sentBody = JSON.parse(options.body as string) as Record<
      string,
      unknown
    >;
    expect(sentBody.boss_name).toBe("鬼上司");
    expect(sentBody.boss_tone_preset).toBe("strict");
    expect(sentBody.boss_strictness).toBe(5);
    expect(typeof sentBody.boss_strictness).toBe("number");
    expect(sentBody.detection_unstarted_fallback_minutes).toBe(30);
    expect(typeof sentBody.detection_unstarted_fallback_minutes).toBe(
      "number",
    );
  });

  it("shows a success message and the next-effective note after a successful save", async () => {
    const fetchMock = stubGet();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SETTINGS),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsView />);
    await waitFor(() =>
      expect(screen.getByLabelText("ボスの名前")).toHaveValue("ボス"),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(screen.getByText("保存しました")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        "設定は次回の応答・次回のチェックから反映されます",
      ),
    ).toBeInTheDocument();
  });

  it("shows an error message and keeps the entered values when the save fails", async () => {
    const fetchMock = stubGet();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          error: "boss_strictness must be an integer between 1 and 5",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsView />);
    await waitFor(() =>
      expect(screen.getByLabelText("ボスの名前")).toHaveValue("ボス"),
    );

    fireEvent.change(screen.getByLabelText("ボスの名前"), {
      target: { value: "鬼上司" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "boss_strictness must be an integer between 1 and 5",
      ),
    );
    expect(screen.getByLabelText("ボスの名前")).toHaveValue("鬼上司");
  });

  it("disables the save button while saving", async () => {
    const fetchMock = stubGet();
    let releaseSave: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSave = () =>
            resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(SAMPLE_SETTINGS),
            });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsView />);
    await waitFor(() =>
      expect(screen.getByLabelText("ボスの名前")).toHaveValue("ボス"),
    );

    const saveButton = screen.getByRole("button", { name: "保存" });
    fireEvent.click(saveButton);

    await waitFor(() => expect(saveButton).toBeDisabled());

    releaseSave?.();
    await waitFor(() => expect(saveButton).toBeEnabled());
  });
});
