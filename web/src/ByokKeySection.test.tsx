import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsView from "./SettingsView";
import ByokKeySection from "./ByokKeySection";
import { ByokKeyCommandError, ByokKeyManagerContext, type ByokKeyManager } from "./byok-key-manager-context";
import type { Settings } from "./settings";

/**
 * 設定画面のキーの欄（#581 S3・機能仕様 docs/features/secure-transport-byok.md
 * 受入基準（S3）S3-U1〜S3-U10）。
 */

const KEY = "sk-ant-test-S3-SECRET";

const SETTINGS: Settings = {
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

function stubSettingsFetch() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(SETTINGS) });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fakeManager(initial: boolean, overrides: Partial<ByokKeyManager> = {}) {
  const manager = {
    isRegistered: vi.fn(async () => initial),
    register: vi.fn<(key: string) => Promise<void>>(async () => undefined),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
  return manager;
}

function keyInput(): HTMLInputElement {
  return screen.getByLabelText("API キー") as HTMLInputElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("設定画面のキーの欄", () => {
  it("S3-U1: キーの操作を注入した設定画面は、登録の有無に応じて「登録済み」「未登録」を表示する", async () => {
    stubSettingsFetch();
    const { unmount } = render(
      <ByokKeyManagerContext.Provider value={fakeManager(true)}>
        <SettingsView />
      </ByokKeyManagerContext.Provider>,
    );
    expect(await screen.findByText("状態: 登録済み")).toBeTruthy();
    unmount();

    render(
      <ByokKeyManagerContext.Provider value={fakeManager(false)}>
        <SettingsView />
      </ByokKeyManagerContext.Provider>,
    );
    expect(await screen.findByText("状態: 未登録")).toBeTruthy();
  });

  it("S3-U2: キーの操作を注入しない設定画面（開発者用の版）にはキーの欄が出ない", async () => {
    stubSettingsFetch();
    render(<SettingsView />);
    await screen.findByText("ボス人格");
    expect(screen.queryByRole("form", { name: "API キー（Anthropic）" })).toBeNull();
    expect(screen.queryByLabelText("API キー")).toBeNull();
  });

  it("S3-U3: 登録すると、provider anthropic の操作に前後の空白を除いたキーを渡す", async () => {
    const manager = fakeManager(false);
    render(<ByokKeySection manager={manager} />);
    fireEvent.change(keyInput(), { target: { value: `  ${KEY}\n` } });
    fireEvent.click(screen.getByRole("button", { name: "登録" }));
    await waitFor(() => expect(manager.register).toHaveBeenCalledWith(KEY));
    expect(await screen.findByText("状態: 登録済み")).toBeTruthy();
  });

  it("S3-U4: 登録に成功すると入力欄は空になる", async () => {
    const manager = fakeManager(false);
    render(<ByokKeySection manager={manager} />);
    fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "登録" }));
    await waitFor(() => expect(keyInput().value).toBe(""));
  });

  it("S3-U5: キーの登録でグローバルの fetch を呼ばない（キーは /api を通らない）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const manager = fakeManager(false);
    render(<ByokKeySection manager={manager} />);
    fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "登録" }));
    await waitFor(() => expect(manager.register).toHaveBeenCalled());
    await screen.findByText("状態: 登録済み");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["成功", async () => undefined],
    [
      "失敗",
      async () => {
        throw new ByokKeyCommandError("key-store-failure", -34018);
      },
    ],
  ])("S3-U6: 登録が%sしても console の各メソッドにキーの文字列が渡らない", async (_label, register) => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    render(<ByokKeySection manager={fakeManager(false, { register: vi.fn(register) })} />);
    fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "登録" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "登録" }) as HTMLButtonElement).closest("fieldset")!.disabled).toBe(false));
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
    }
  });

  it("S3-U7: 削除すると provider anthropic の削除を呼び、「未登録」を表示する", async () => {
    const manager = fakeManager(true);
    render(<ByokKeySection manager={manager} />);
    await screen.findByText("状態: 登録済み");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    await waitFor(() => expect(manager.remove).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("状態: 未登録")).toBeTruthy();
  });

  it("S3-U8: 登録が key-store-failure・OSStatus -34018 で失敗すると、-34018 を含むエラーを表示する", async () => {
    const manager = fakeManager(false, {
      register: vi.fn(async () => {
        throw new ByokKeyCommandError("key-store-failure", -34018);
      }),
    });
    render(<ByokKeySection manager={manager} />);
    fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "登録" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("-34018");
    expect(alert.textContent).not.toContain(KEY);
  });

  it("S3-U9: キーの入力欄の type は password である", async () => {
    render(<ByokKeySection manager={fakeManager(false)} />);
    await screen.findByText("状態: 未登録");
    expect(keyInput().type).toBe("password");
  });

  it("S3-U10: 入力欄が空（空白だけを含む）のとき、登録のボタンは押せない", async () => {
    const manager = fakeManager(false);
    render(<ByokKeySection manager={manager} />);
    await screen.findByText("状態: 未登録");
    const button = screen.getByRole("button", { name: "登録" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(keyInput(), { target: { value: "   " } });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(manager.register).not.toHaveBeenCalled();
  });
});

/**
 * マウント時の登録の有無の取得が、その後の登録・削除より遅れて返ったとき（#659）。
 * 遅れて返った古い値で、操作の結果の表示を上書きしない。
 */
describe("設定画面のキーの欄: 遅れて返る初回の取得", () => {
  function deferredIsRegistered() {
    let resolve!: (value: boolean) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<boolean>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { isRegistered: vi.fn(() => promise), resolve, reject };
  }

  async function registerKey() {
    fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "登録" }));
    await screen.findByText("状態: 登録済み");
  }

  it("登録の後に初回の取得が「未登録」で返っても、「登録済み」のまま", async () => {
    const pending = deferredIsRegistered();
    render(<ByokKeySection manager={fakeManager(false, { isRegistered: pending.isRegistered })} />);
    await registerKey();

    await act(async () => pending.resolve(false));

    expect(screen.getByText("状態: 登録済み")).toBeTruthy();
  });

  it("登録・削除の後に初回の取得が「登録済み」で返っても、「未登録」のまま", async () => {
    const pending = deferredIsRegistered();
    const manager = fakeManager(false, { isRegistered: pending.isRegistered });
    render(<ByokKeySection manager={manager} />);
    await registerKey();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    await screen.findByText("状態: 未登録");

    await act(async () => pending.resolve(true));

    expect(screen.getByText("状態: 未登録")).toBeTruthy();
  });

  it("登録の後に初回の取得が失敗して返っても、エラーを表示しない", async () => {
    const pending = deferredIsRegistered();
    render(<ByokKeySection manager={fakeManager(false, { isRegistered: pending.isRegistered })} />);
    await registerKey();

    await act(async () => pending.reject(new ByokKeyCommandError("key-store-failure", -34018)));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("状態: 登録済み")).toBeTruthy();
  });

  it("登録が失敗したときは、遅れて返った初回の取得の結果を表示する", async () => {
    const pending = deferredIsRegistered();
    const manager = fakeManager(false, {
      isRegistered: pending.isRegistered,
      register: vi.fn(async () => {
        throw new ByokKeyCommandError("key-store-failure", -34018);
      }),
    });
    render(<ByokKeySection manager={manager} />);
    fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "登録" }));
    await screen.findByRole("alert");

    pending.resolve(false);

    expect(await screen.findByText("状態: 未登録")).toBeTruthy();
  });
});
