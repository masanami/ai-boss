import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsView from "./SettingsView";
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

/**
 * `PUT /api/settings` の 200 の本文（#708 決定 18: `{ settings, warnings }` の入れ子。
 * GET の本文は平坦なまま）。
 */
function putBody(settings: Settings, warnings: SettingsWarning[] = []) {
  return { settings, warnings };
}

describe("SettingsView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("./use-settings");
    vi.resetModules();
  });

  it("shows a loading indicator while settings are loading", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<SettingsView />);

    expect(screen.getByText("読み込み中…")).toBeInTheDocument();
  });

  it("keeps showing the loading view (not the error) when settings are ready but the form is not yet initialized", async () => {
    // 実フックでは settings 到着後、form を初期化する useEffect が走るまでの
    // 1フレームだけ status === "ready" かつ form === null になる。この過渡
    // フレームで誤ってエラー表示にならないことを、フックのモックで固定化
    // した同状態により検証する。
    vi.doMock("./use-settings", () => ({
      useSettings: () => ({
        settings: null,
        status: "ready" as const,
        saveError: null,
        saveWarnings: [],
        isSaving: false,
        saveSettings: vi.fn(),
      }),
    }));
    const { default: MockedSettingsView } = await import("./SettingsView");

    render(<MockedSettingsView />);

    expect(screen.getByText("読み込み中…")).toBeInTheDocument();
    expect(
      screen.queryByText("設定の取得に失敗しました"),
    ).not.toBeInTheDocument();
  });

  it("disables the form fields while saving so in-flight edits are not silently overwritten", async () => {
    const fetchMock = stubGet();
    let releaseSave: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSave = () =>
            resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(putBody(SAMPLE_SETTINGS)),
            });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsView />);
    await waitFor(() =>
      expect(screen.getByLabelText("ボスの名前")).toHaveValue("ボス"),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    // 各 fieldset から1フィールドずつ、保存中は編集不可であることを確認する
    await waitFor(() =>
      expect(screen.getByLabelText("ボスの名前")).toBeDisabled(),
    );
    expect(screen.getByLabelText("追加の指示")).toBeDisabled();
    expect(screen.getByLabelText("朝会の時刻")).toBeDisabled();
    expect(screen.getByLabelText("勤務開始")).toBeDisabled();
    expect(
      screen.getByLabelText("未着手のフォールバック（分）"),
    ).toBeDisabled();
    expect(screen.getByLabelText("モデル")).toBeDisabled();

    releaseSave?.();
    await waitFor(() =>
      expect(screen.getByLabelText("ボスの名前")).toBeEnabled(),
    );
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
      json: () => Promise.resolve(putBody(SAMPLE_SETTINGS)),
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
          detection_daily_notification_cap: 5,
          model: "claude-sonnet-5",
          evidence_enforcement_enabled: false,
          morning_mentoring_required: true,
        }),
      }),
    );
  });

  it("submits edited values with the correct types (numbers stay numbers)", async () => {
    const fetchMock = stubGet();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(putBody({ ...SAMPLE_SETTINGS, boss_name: "鬼上司" })),
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
      json: () => Promise.resolve(putBody(SAMPLE_SETTINGS)),
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

  it("shows the evidence-enforcement checkbox reflecting the loaded value (AC-65)", async () => {
    vi.stubGlobal(
      "fetch",
      stubGet({ ...SAMPLE_SETTINGS, evidence_enforcement_enabled: true }),
    );

    render(<SettingsView />);

    await waitFor(() =>
      expect(
        screen.getByLabelText("完了報告にエビデンスを必須にする"),
      ).toBeChecked(),
    );
  });

  it("submits evidence_enforcement_enabled: true after the checkbox is toggled (AC-65)", async () => {
    const fetchMock = stubGet();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(putBody({ ...SAMPLE_SETTINGS, evidence_enforcement_enabled: true })),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsView />);
    await waitFor(() =>
      expect(
        screen.getByLabelText("完了報告にエビデンスを必須にする"),
      ).not.toBeChecked(),
    );

    fireEvent.click(
      screen.getByLabelText("完了報告にエビデンスを必須にする"),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    const sentBody = JSON.parse(options.body as string) as Record<
      string,
      unknown
    >;
    expect(sentBody.evidence_enforcement_enabled).toBe(true);
  });

  it("shows the loaded daily notification cap in the detection-threshold fieldset (#562)", async () => {
    vi.stubGlobal(
      "fetch",
      stubGet({ ...SAMPLE_SETTINGS, detection_daily_notification_cap: 7 }),
    );

    render(<SettingsView />);

    const input = await screen.findByLabelText("1 日の通知上限（回）");
    expect(input).toHaveValue(7);
    expect(input.closest("fieldset")).toHaveTextContent("検知閾値");
  });

  it("submits the edited daily notification cap as a number (#562)", async () => {
    const fetchMock = stubGet();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(putBody({ ...SAMPLE_SETTINGS, detection_daily_notification_cap: 3 })),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsView />);
    await waitFor(() =>
      expect(screen.getByLabelText("1 日の通知上限（回）")).toHaveValue(5),
    );

    fireEvent.change(screen.getByLabelText("1 日の通知上限（回）"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    const sentBody = JSON.parse(options.body as string) as Record<
      string,
      unknown
    >;
    expect(sentBody.detection_daily_notification_cap).toBe(3);
  });

  it("shows the mentoring-required checkbox checked when unset (server returns true) (AC-38)", async () => {
    vi.stubGlobal(
      "fetch",
      stubGet({ ...SAMPLE_SETTINGS, morning_mentoring_required: true }),
    );

    render(<SettingsView />);

    await waitFor(() =>
      expect(
        screen.getByLabelText("朝会でメンタリングを必須にする"),
      ).toBeChecked(),
    );
  });

  it("shows the mentoring-required checkbox unchecked when the loaded value is false (AC-38)", async () => {
    vi.stubGlobal(
      "fetch",
      stubGet({ ...SAMPLE_SETTINGS, morning_mentoring_required: false }),
    );

    render(<SettingsView />);

    await waitFor(() =>
      expect(
        screen.getByLabelText("朝会でメンタリングを必須にする"),
      ).not.toBeChecked(),
    );
  });

  it("submits morning_mentoring_required: false after the checkbox is toggled off (AC-38)", async () => {
    const fetchMock = stubGet();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(putBody({
          ...SAMPLE_SETTINGS,
          morning_mentoring_required: false,
        })),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsView />);
    await waitFor(() =>
      expect(
        screen.getByLabelText("朝会でメンタリングを必須にする"),
      ).toBeChecked(),
    );

    fireEvent.click(
      screen.getByLabelText("朝会でメンタリングを必須にする"),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    const sentBody = JSON.parse(options.body as string) as Record<
      string,
      unknown
    >;
    expect(sentBody.morning_mentoring_required).toBe(false);
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
              json: () => Promise.resolve(putBody(SAMPLE_SETTINGS)),
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
  // #708・機能仕様 docs/features/working-hours-intervals.md 決定 18・22・
  // 受入基準（S4）「設定画面」。警告の文面はサーバが組み立てて返すため、
  // ここでは応答の message がそのまま表示されることだけを見る。
  describe("会の時刻と稼働時間帯の整合警告（#708）", () => {
    const OUTSIDE_SETTINGS: Settings = {
      ...SAMPLE_SETTINGS,
      morning_meeting_time: "08:30",
      evening_meeting_time: "19:00",
    };
    const MORNING_WARNING: SettingsWarning = {
      code: "meeting_outside_working_hours",
      key: "morning_meeting_time",
      message: "朝会の時刻（08:30）が勤務時間帯（09:00〜18:00）の外にあります",
    };
    const EVENING_WARNING: SettingsWarning = {
      code: "meeting_outside_working_hours",
      key: "evening_meeting_time",
      message: "夕会の時刻（19:00）が勤務時間帯（09:00〜18:00）の外にあります",
    };

    function okPut(settings: Settings, warnings: SettingsWarning[]) {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(putBody(settings, warnings)),
      };
    }

    async function renderAndSave(fetchMock: ReturnType<typeof vi.fn>) {
      vi.stubGlobal("fetch", fetchMock);
      render(<SettingsView />);
      await waitFor(() =>
        expect(screen.getByLabelText("ボスの名前")).toHaveValue("ボス"),
      );
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() =>
        expect(screen.getByText("保存しました")).toBeInTheDocument(),
      );
    }

    it("警告が 1 件のとき、その message が role=alert で表示され、「保存しました」も表示される", async () => {
      const fetchMock = stubGet();
      fetchMock.mockResolvedValueOnce(
        okPut({ ...SAMPLE_SETTINGS, morning_meeting_time: "08:30" }, [MORNING_WARNING]),
      );

      await renderAndSave(fetchMock);

      expect(screen.getByRole("alert")).toHaveTextContent(MORNING_WARNING.message);
      expect(screen.getByText("保存しました")).toBeInTheDocument();
    });

    it("警告が 2 件のとき、2 件の message がいずれも role=alert で表示される", async () => {
      const fetchMock = stubGet();
      fetchMock.mockResolvedValueOnce(
        okPut(OUTSIDE_SETTINGS, [MORNING_WARNING, EVENING_WARNING]),
      );

      await renderAndSave(fetchMock);

      const alerts = screen.getAllByRole("alert");
      expect(alerts.map((alert) => alert.textContent)).toEqual([
        MORNING_WARNING.message,
        EVENING_WARNING.message,
      ]);
    });

    it("警告が空配列のとき、role=alert の要素は無い", async () => {
      const fetchMock = stubGet();
      fetchMock.mockResolvedValueOnce(okPut(SAMPLE_SETTINGS, []));

      await renderAndSave(fetchMock);

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("警告のある保存の後、フォームの各入力欄には応答の settings の値が表示される", async () => {
      const fetchMock = stubGet();
      const saved = { ...OUTSIDE_SETTINGS, boss_name: "鬼上司" };
      fetchMock.mockResolvedValueOnce(okPut(saved, [MORNING_WARNING, EVENING_WARNING]));

      vi.stubGlobal("fetch", fetchMock);
      render(<SettingsView />);
      await waitFor(() =>
        expect(screen.getByLabelText("ボスの名前")).toHaveValue("ボス"),
      );
      fireEvent.click(screen.getByRole("button", { name: "保存" }));

      await waitFor(() =>
        expect(screen.getByLabelText("ボスの名前")).toHaveValue("鬼上司"),
      );
      expect(screen.getByLabelText("朝会の時刻")).toHaveValue("08:30");
      expect(screen.getByLabelText("夕会の時刻")).toHaveValue("19:00");
      expect(screen.getByLabelText("勤務開始")).toHaveValue("09:00");
      expect(screen.getByLabelText("勤務終了")).toHaveValue("18:00");
    });

    it("警告のある保存の後に続けて保存したとき、2 回目の PUT の本文のキーの集合は Settings の 18 キーと等しい（warnings を含まない）", async () => {
      const fetchMock = stubGet();
      fetchMock.mockResolvedValueOnce(
        okPut(OUTSIDE_SETTINGS, [MORNING_WARNING, EVENING_WARNING]),
      );
      fetchMock.mockResolvedValueOnce(
        okPut(OUTSIDE_SETTINGS, [MORNING_WARNING, EVENING_WARNING]),
      );
      await renderAndSave(fetchMock);

      fireEvent.click(screen.getByRole("button", { name: "保存" }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      const [, options] = fetchMock.mock.calls[2] as [string, RequestInit];
      const sentBody = JSON.parse(options.body as string) as Record<string, unknown>;
      expect(Object.keys(sentBody).sort()).toEqual(Object.keys(SAMPLE_SETTINGS).sort());
      expect(Object.keys(sentBody)).toHaveLength(18);
      expect(sentBody).not.toHaveProperty("warnings");
      expect(sentBody).not.toHaveProperty("settings");
    });

    it("警告のある保存の後に次の保存を送信し、その応答が返る前（保存中）は、前回の警告は表示されない", async () => {
      const fetchMock = stubGet();
      fetchMock.mockResolvedValueOnce(
        okPut({ ...SAMPLE_SETTINGS, morning_meeting_time: "08:30" }, [MORNING_WARNING]),
      );
      let releaseSave: (() => void) | undefined;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSave = () => resolve(okPut(SAMPLE_SETTINGS, []));
          }),
      );
      await renderAndSave(fetchMock);
      expect(screen.getByRole("alert")).toHaveTextContent(MORNING_WARNING.message);

      const saveButton = screen.getByRole("button", { name: "保存" });
      fireEvent.click(saveButton);

      await waitFor(() => expect(saveButton).toBeDisabled());
      expect(screen.queryByText(MORNING_WARNING.message)).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      releaseSave?.();
      await waitFor(() => expect(saveButton).toBeEnabled());
    });

    it("警告のある保存の後、次の保存の warnings が空配列なら、前回の警告は表示されない", async () => {
      const fetchMock = stubGet();
      fetchMock.mockResolvedValueOnce(
        okPut({ ...SAMPLE_SETTINGS, morning_meeting_time: "08:30" }, [MORNING_WARNING]),
      );
      fetchMock.mockResolvedValueOnce(okPut(SAMPLE_SETTINGS, []));
      await renderAndSave(fetchMock);
      expect(screen.getByRole("alert")).toHaveTextContent(MORNING_WARNING.message);

      fireEvent.click(screen.getByRole("button", { name: "保存" }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      await waitFor(() =>
        expect(screen.getByText("保存しました")).toBeInTheDocument(),
      );
      expect(screen.queryByText(MORNING_WARNING.message)).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("警告のある保存の後、次の保存が 400 になったとき、前回の警告は表示されず、400 の error が role=alert で表示される", async () => {
      const fetchMock = stubGet();
      fetchMock.mockResolvedValueOnce(
        okPut({ ...SAMPLE_SETTINGS, morning_meeting_time: "08:30" }, [MORNING_WARNING]),
      );
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: "勤務開始は勤務終了より前の時刻にしてください",
            code: "invalid_working_hours",
          }),
      });
      await renderAndSave(fetchMock);
      expect(screen.getByRole("alert")).toHaveTextContent(MORNING_WARNING.message);

      fireEvent.click(screen.getByRole("button", { name: "保存" }));

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "勤務開始は勤務終了より前の時刻にしてください",
        ),
      );
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.queryByText(MORNING_WARNING.message)).not.toBeInTheDocument();
    });
  });
});
