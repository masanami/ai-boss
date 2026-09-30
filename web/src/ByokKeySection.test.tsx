import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SettingsView from "./SettingsView";
import ByokKeySection from "./ByokKeySection";
import {
  ByokKeyCommandError,
  ByokKeyManagerContext,
  type ByokKeyManager,
  type ByokKeyManagers,
} from "./byok-key-manager-context";
import type { Settings } from "./settings";

/**
 * 設定画面のキーの欄（#581 S3・機能仕様 docs/features/secure-transport-byok.md
 * 受入基準（S3）S3-U1〜S3-U10）と、OpenAI のキーの欄（#582 S2・機能仕様
 * docs/features/llm-provider-abstraction.md 受入基準（S2）S2-U1〜S2-U8c）。
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

const UNSELECTED = {
  provider: null,
  model: null,
  modelInCatalog: false,
  catalog: [
    { provider: "anthropic", modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5", isDefault: true },
    { provider: "openai", modelId: "gpt-6-sol", displayName: "GPT-6 Sol", isDefault: true },
  ],
};

// 製品版の設定画面は選択の欄のために /api/llm-selection も読む（#582 S2）。URL で応答を分ける。
function stubSettingsFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(String(input).includes("llm-selection") ? UNSELECTED : SETTINGS),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function managers(anthropic: ByokKeyManager, openai: ByokKeyManager = fakeManager(false)): ByokKeyManagers {
  return { anthropic, openai };
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
      // 準備の変更（#582 S2）: OpenAI の欄と区別するため、OpenAI の登録の有無は逆にしておく。
      <ByokKeyManagerContext.Provider value={managers(fakeManager(true), fakeManager(false))}>
        <SettingsView />
      </ByokKeyManagerContext.Provider>,
    );
    expect(await screen.findByText("状態: 登録済み")).toBeTruthy();
    unmount();

    render(
      <ByokKeyManagerContext.Provider value={managers(fakeManager(false), fakeManager(true))}>
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

describe("設定画面のキーの欄（OpenAI・#582 S2）", () => {
  const OPENAI_KEY = "sk-proj-test-S2-SECRET";

  async function renderProduct(openai: ByokKeyManager, anthropic: ByokKeyManager = fakeManager(true)) {
    stubSettingsFetch();
    render(
      <ByokKeyManagerContext.Provider value={managers(anthropic, openai)}>
        <SettingsView />
      </ByokKeyManagerContext.Provider>,
    );
    return within(await screen.findByRole("form", { name: "API キー（OpenAI）" }));
  }

  it("S2-U1: 「API キー（OpenAI）」の欄は、OpenAI のキーの操作の登録の有無に応じて「登録済み」「未登録」を表示する（Anthropic の欄は影響を受けない）", async () => {
    const registered = await renderProduct(fakeManager(true), fakeManager(false));
    expect(await registered.findByText("状態: 登録済み")).toBeTruthy();
    const anthropic = within(screen.getByRole("form", { name: "API キー（Anthropic）" }));
    expect(await anthropic.findByText("状態: 未登録")).toBeTruthy();
  });

  it("S2-U1: OpenAI のキーの操作の登録の有無が未登録なら「未登録」を表示する", async () => {
    const section = await renderProduct(fakeManager(false), fakeManager(true));
    expect(await section.findByText("状態: 未登録")).toBeTruthy();
  });

  it("S2-U2: 登録すると OpenAI のキーの操作の登録が前後の空白を除いたキーで呼ばれ、Anthropic のキーの操作の登録は呼ばれない", async () => {
    const openai = fakeManager(false);
    const anthropic = fakeManager(true);
    const section = await renderProduct(openai, anthropic);
    await section.findByText("状態: 未登録");
    fireEvent.change(section.getByLabelText("API キー"), { target: { value: `  ${OPENAI_KEY}\n` } });
    fireEvent.click(section.getByRole("button", { name: "登録" }));

    await waitFor(() => expect(openai.register).toHaveBeenCalledWith(OPENAI_KEY));
    expect(anthropic.register).not.toHaveBeenCalled();
  });

  it("S2-U3: 登録に成功すると入力欄は空になる", async () => {
    const section = await renderProduct(fakeManager(false));
    await section.findByText("状態: 未登録");
    const input = section.getByLabelText("API キー") as HTMLInputElement;
    fireEvent.change(input, { target: { value: OPENAI_KEY } });
    fireEvent.click(section.getByRole("button", { name: "登録" }));

    await waitFor(() => expect(input.value).toBe(""));
    expect(await section.findByText("状態: 登録済み")).toBeTruthy();
  });

  it("S2-U4: 登録でグローバルの fetch は呼ばれない（キーは /api を通らない）", async () => {
    const openai = fakeManager(false);
    const section = await renderProduct(openai);
    await section.findByText("状態: 未登録");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fireEvent.change(section.getByLabelText("API キー"), { target: { value: OPENAI_KEY } });
    fireEvent.click(section.getByRole("button", { name: "登録" }));

    await waitFor(() => expect(openai.register).toHaveBeenCalled());
    await section.findByText("状態: 登録済み");
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
  ])("S2-U5: 登録が%sしても console の各メソッドに入力したキーの文字列が渡らない", async (_label, register) => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const section = await renderProduct(fakeManager(false, { register: vi.fn(register) }));
    await section.findByText("状態: 未登録");
    fireEvent.change(section.getByLabelText("API キー"), { target: { value: OPENAI_KEY } });
    fireEvent.click(section.getByRole("button", { name: "登録" }));
    await waitFor(() =>
      expect((section.getByRole("button", { name: "登録" }) as HTMLButtonElement).closest("fieldset")!.disabled).toBe(false),
    );
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(OPENAI_KEY);
    }
  });

  it("S2-U5: 登録が失敗したときの画面の表示にも入力したキーの文字列は含まれない", async () => {
    const section = await renderProduct(
      fakeManager(false, {
        register: vi.fn(async () => {
          throw new ByokKeyCommandError("key-store-failure", -34018);
        }),
      }),
    );
    await section.findByText("状態: 未登録");
    fireEvent.change(section.getByLabelText("API キー"), { target: { value: OPENAI_KEY } });
    fireEvent.click(section.getByRole("button", { name: "登録" }));

    const alert = await section.findByRole("alert");
    expect(alert.textContent).toContain("-34018");
    expect(document.body.textContent).not.toContain(OPENAI_KEY);
  });

  it("S2-U6: 入力欄の type は password である", async () => {
    const section = await renderProduct(fakeManager(false));
    await section.findByText("状態: 未登録");
    expect((section.getByLabelText("API キー") as HTMLInputElement).type).toBe("password");
  });

  it("S2-U7: 削除すると OpenAI のキーの操作の削除が呼ばれ、「未登録」が表示される", async () => {
    const openai = fakeManager(true);
    const anthropic = fakeManager(true);
    const section = await renderProduct(openai, anthropic);
    await section.findByText("状態: 登録済み");
    fireEvent.click(section.getByRole("button", { name: "削除" }));

    await waitFor(() => expect(openai.remove).toHaveBeenCalledTimes(1));
    expect(anthropic.remove).not.toHaveBeenCalled();
    expect(await section.findByText("状態: 未登録")).toBeTruthy();
  });

  it("S2-U8: キーの操作を注入しない設定画面（開発者用の版）には、選択の欄が表示されず、/api/llm-selection も呼ばれない", async () => {
    const fetchMock = stubSettingsFetch();
    render(<SettingsView />);
    await screen.findByText("ボス人格");

    expect(screen.queryByRole("form", { name: "LLM（プロバイダとモデル）" })).toBeNull();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(["/api/settings"]);
  });

  it("S2-U8b: キーの操作を注入しない設定画面には、「API キー（Anthropic）」の欄と「API キー（OpenAI）」の欄が表示されない", async () => {
    stubSettingsFetch();
    render(<SettingsView />);
    await screen.findByText("ボス人格");

    expect(screen.queryByRole("form", { name: "API キー（Anthropic）" })).toBeNull();
    expect(screen.queryByRole("form", { name: "API キー（OpenAI）" })).toBeNull();
  });

  it("S2-U8c: キーの操作を注入しない設定画面には、自由入力の「モデル」の欄が表示される", async () => {
    stubSettingsFetch();
    render(<SettingsView />);

    const model = (await screen.findByLabelText("モデル")) as HTMLInputElement;
    expect(model.tagName).toBe("INPUT");
    expect(model.value).toBe("claude-sonnet-5");
  });
});
