import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SettingsView from "./SettingsView";
import { ByokKeyManagerContext, type ByokKeyManager } from "./byok-key-manager-context";
import type { LlmSelectionState } from "./llm-selection-api";
import type { Settings } from "./settings";

/**
 * 設定画面の選択の欄（#582 S2・機能仕様 docs/features/llm-provider-abstraction.md
 * 受入基準（S2）S2-V1〜S2-V9）。製品版の設定画面（キーの操作を注入）を
 * `/api/settings`・`/api/llm-selection` の模擬の `fetch` で描画して確かめる。
 */

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

const CATALOG: LlmSelectionState["catalog"] = [
  { provider: "anthropic", modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5", isDefault: true },
  { provider: "anthropic", modelId: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", isDefault: false },
  { provider: "openai", modelId: "gpt-6-sol", displayName: "GPT-6 Sol", isDefault: true },
  { provider: "openai", modelId: "gpt-6-luna", displayName: "GPT-6 Luna", isDefault: false },
];

const UNSELECTED: LlmSelectionState = { provider: null, model: null, modelInCatalog: false, catalog: CATALOG };

function selected(provider: "anthropic" | "openai", model: string): LlmSelectionState {
  return { provider, model, modelInCatalog: true, catalog: CATALOG };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** URL とメソッドで応答を分ける模擬の fetch。呼び出しを `calls` に残す。 */
function stubFetch(options: {
  selection: LlmSelectionState;
  put?: (body: { provider: string; model: string }) => { status: number; body: unknown };
  selectionGetFails?: boolean;
}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const respond = (status: number, payload: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(payload),
    });
    if (url === "/api/llm-selection") {
      if (method === "PUT") {
        const result = options.put?.(body) ?? { status: 200, body: selected(body.provider, body.model) };
        return respond(result.status, result.body);
      }
      return options.selectionGetFails ? respond(500, { error: "x" }) : respond(200, options.selection);
    }
    if (url === "/api/settings") return respond(200, SETTINGS);
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function fakeManager(): ByokKeyManager {
  return { isRegistered: async () => false, register: async () => undefined, remove: async () => undefined };
}

async function renderProductSettings() {
  render(
    <ByokKeyManagerContext.Provider value={{ anthropic: fakeManager(), openai: fakeManager() }}>
      <SettingsView />
    </ByokKeyManagerContext.Provider>,
  );
  const form = await screen.findByRole("form", { name: "LLM（プロバイダとモデル）" });
  return within(form);
}

function optionValues(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options)
    .map((option) => option.value)
    .filter((value) => value !== "");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("設定画面の選択の欄（製品版）", () => {
  it("S2-V1: キーの操作を注入した設定画面には選択の欄が表示される", async () => {
    stubFetch({ selection: UNSELECTED });
    const section = await renderProductSettings();

    expect(section.getByLabelText("プロバイダ")).toBeTruthy();
    expect(section.getByLabelText("使うモデル")).toBeTruthy();
  });

  it("S2-V1b: キーの操作を注入した設定画面には、自由入力の「モデル」の欄が表示されない", async () => {
    stubFetch({ selection: UNSELECTED });
    await renderProductSettings();

    expect(screen.queryByLabelText("モデル")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "モデル" })).toBeNull();
    expect(screen.queryByRole("group", { name: "モデル" })).toBeNull();
  });

  it("S2-V2: プロバイダの選択肢は Anthropic と OpenAI の 2 つだけである", async () => {
    stubFetch({ selection: UNSELECTED });
    const section = await renderProductSettings();

    const select = section.getByLabelText("プロバイダ") as HTMLSelectElement;
    expect(optionValues(select)).toEqual(["anthropic", "openai"]);
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "選んでください",
      "Anthropic",
      "OpenAI",
    ]);
  });

  it("S2-V2b: OpenAI を選ぶと、モデルの選択肢は gpt-6-sol と gpt-6-luna の 2 つだけである", async () => {
    stubFetch({ selection: UNSELECTED });
    const section = await renderProductSettings();

    fireEvent.change(section.getByLabelText("プロバイダ"), { target: { value: "openai" } });

    expect(optionValues(section.getByLabelText("使うモデル"))).toEqual(["gpt-6-sol", "gpt-6-luna"]);
  });

  it("S2-V2c: Anthropic を選ぶと、モデルの選択肢は claude-sonnet-5 と claude-haiku-4-5 の 2 つだけである", async () => {
    stubFetch({ selection: UNSELECTED });
    const section = await renderProductSettings();

    fireEvent.change(section.getByLabelText("プロバイダ"), { target: { value: "anthropic" } });

    expect(optionValues(section.getByLabelText("使うモデル"))).toEqual(["claude-sonnet-5", "claude-haiku-4-5"]);
  });

  it("S2-V2d: 選択の欄の中に input 要素と textarea 要素が 1 つも無い", async () => {
    stubFetch({ selection: selected("openai", "gpt-6-sol") });
    const section = await renderProductSettings();
    await screen.findByDisplayValue("GPT-6 Sol");

    const form = section.getByLabelText("プロバイダ").closest("form")!;
    expect(form.querySelectorAll("input, textarea")).toHaveLength(0);
    expect(form.querySelectorAll("select")).toHaveLength(2);
  });

  it("S2-V3: OpenAI と gpt-6-luna を選んで保存すると、PUT /api/llm-selection が { provider, model } で呼ばれ、「保存しました」が表示される", async () => {
    const { calls } = stubFetch({ selection: UNSELECTED });
    const section = await renderProductSettings();

    fireEvent.change(section.getByLabelText("プロバイダ"), { target: { value: "openai" } });
    fireEvent.change(section.getByLabelText("使うモデル"), { target: { value: "gpt-6-luna" } });
    fireEvent.click(section.getByRole("button", { name: "選択を保存" }));

    expect(await section.findByText("保存しました")).toBeTruthy();
    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts).toEqual([{ url: "/api/llm-selection", method: "PUT", body: { provider: "openai", model: "gpt-6-luna" } }]);
  });

  it("S2-V4: GET が保存済みの anthropic・claude-haiku-4-5 を返すと、選択の欄はそのプロバイダとモデルを選んだ状態で表示される", async () => {
    stubFetch({ selection: selected("anthropic", "claude-haiku-4-5") });
    const section = await renderProductSettings();

    await waitFor(() => expect((section.getByLabelText("プロバイダ") as HTMLSelectElement).value).toBe("anthropic"));
    expect((section.getByLabelText("使うモデル") as HTMLSelectElement).value).toBe("claude-haiku-4-5");
    expect(section.queryByRole("status")).toBeNull();
    expect((section.getByRole("button", { name: "選択を保存" }) as HTMLButtonElement).disabled).toBe(false);
  });

  describe("保存したモデルが一覧に無いとき", () => {
    const astra: LlmSelectionState = { provider: "openai", model: "gpt-6-astra", modelInCatalog: false, catalog: CATALOG };

    it("S2-V5: そのモデル ID と「選び直し」を求める案内を表示する", async () => {
      stubFetch({ selection: astra });
      const section = await renderProductSettings();

      const guidance = await section.findByRole("status");
      expect(guidance.textContent).toContain("gpt-6-astra");
      expect(guidance.textContent).toContain("選び直");
    });

    it("S2-V5b: モデルの選択肢はどれも選ばれていない（既定のモデルで埋めない）が、プロバイダは保存済みの OpenAI のまま", async () => {
      stubFetch({ selection: astra });
      const section = await renderProductSettings();
      await section.findByRole("status");

      expect((section.getByLabelText("プロバイダ") as HTMLSelectElement).value).toBe("openai");
      const model = section.getByLabelText("使うモデル") as HTMLSelectElement;
      expect(model.value).toBe("");
      expect(optionValues(model)).toEqual(["gpt-6-sol", "gpt-6-luna"]);
    });

    it("S2-V5c: 保存のボタンは押せない", async () => {
      stubFetch({ selection: astra });
      const section = await renderProductSettings();
      await section.findByRole("status");

      expect((section.getByRole("button", { name: "選択を保存" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("S2-V6: 一覧のモデルを選んで保存すると、PUT がそのモデルで呼ばれ、成功すると選び直しの案内は消える", async () => {
      const { calls } = stubFetch({ selection: astra });
      const section = await renderProductSettings();
      await section.findByRole("status");

      fireEvent.change(section.getByLabelText("使うモデル"), { target: { value: "gpt-6-sol" } });
      const save = section.getByRole("button", { name: "選択を保存" }) as HTMLButtonElement;
      expect(save.disabled).toBe(false);
      fireEvent.click(save);

      expect(await section.findByText("保存しました")).toBeTruthy();
      expect(calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([
        { provider: "openai", model: "gpt-6-sol" },
      ]);
      expect(section.queryByRole("status")).toBeNull();
    });

    it("他方のプロバイダに変えたときも、モデルは選び直すまで未選択で、保存は押せない", async () => {
      stubFetch({ selection: astra });
      const section = await renderProductSettings();
      await section.findByRole("status");

      fireEvent.change(section.getByLabelText("プロバイダ"), { target: { value: "anthropic" } });

      expect((section.getByLabelText("使うモデル") as HTMLSelectElement).value).toBe("");
      expect((section.getByRole("button", { name: "選択を保存" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("S2-V7: 未選択を返すと、プロバイダとモデルを選ぶよう求める案内を表示し、両方を選ぶまで保存のボタンは押せない", async () => {
    stubFetch({ selection: UNSELECTED });
    const section = await renderProductSettings();

    const guidance = await section.findByRole("status");
    expect(guidance.textContent).toContain("プロバイダとモデルを選んで保存してください");
    const save = section.getByRole("button", { name: "選択を保存" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(section.getByLabelText("プロバイダ"), { target: { value: "anthropic" } });
    expect(save.disabled).toBe(true);

    fireEvent.change(section.getByLabelText("使うモデル"), { target: { value: "claude-haiku-4-5" } });
    expect(save.disabled).toBe(false);
  });

  it("S2-V7: モデルの選択肢は、プロバイダを選ぶまで選べない", async () => {
    stubFetch({ selection: UNSELECTED });
    const section = await renderProductSettings();

    expect((section.getByLabelText("使うモデル") as HTMLSelectElement).disabled).toBe(true);
  });

  it("S2-V8: PUT が 400 を返すと、エラーを表示し、「保存しました」を表示しない", async () => {
    stubFetch({
      selection: UNSELECTED,
      put: () => ({ status: 400, body: { error: "選んだプロバイダで使えるモデルの一覧から選んでください" } }),
    });
    const section = await renderProductSettings();

    fireEvent.change(section.getByLabelText("プロバイダ"), { target: { value: "openai" } });
    fireEvent.change(section.getByLabelText("使うモデル"), { target: { value: "gpt-6-luna" } });
    fireEvent.click(section.getByRole("button", { name: "選択を保存" }));

    const alert = await section.findByRole("alert");
    expect(alert.textContent).toContain("選んだプロバイダで使えるモデルの一覧から選んでください");
    expect(section.queryByText("保存しました")).toBeNull();
    // 案内は残る（保存されていないため、まだ LLM は使えない）。
    expect(section.getByRole("status")).toBeTruthy();
  });

  it("選択の取得に失敗すると、エラーを表示し、選択の操作は出さない", async () => {
    stubFetch({ selection: UNSELECTED, selectionGetFails: true });
    render(
      <ByokKeyManagerContext.Provider value={{ anthropic: fakeManager(), openai: fakeManager() }}>
        <SettingsView />
      </ByokKeyManagerContext.Provider>,
    );

    const alert = await screen.findByText("LLM の選択の取得に失敗しました");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(screen.queryByRole("button", { name: "選択を保存" })).toBeNull();
  });

  it("S2-V9: 設定の保存のフォームの保存（PUT /api/settings）の本文に byok_provider・byok_model は含まれない", async () => {
    const { calls } = stubFetch({ selection: selected("openai", "gpt-6-luna") });
    await renderProductSettings();

    // 設定の保存のフォームの「保存」（選択の欄のボタンは「選択を保存」）。
    fireEvent.click(await screen.findByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((call) => call.url === "/api/settings" && call.method === "PUT")).toBe(true));
    const put = calls.find((call) => call.url === "/api/settings" && call.method === "PUT")!;
    expect(Object.keys(put.body as object).filter((key) => key.startsWith("byok_"))).toEqual([]);
    expect(Object.keys(put.body as object)).not.toContain("byok_provider");
    expect(Object.keys(put.body as object)).not.toContain("byok_model");
  });
});
