import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createHookedTestDb } from "../db/test-support/create-test-db.js";
import type { DbPort } from "../db/db-port.js";
import type { DriverHook } from "../db/test-support/hooked-driver.js";
import { createCoreApp } from "../core-app.js";
import { resetLlmBackendRegistryForTest } from "../llm/llm-backend-registry.js";
import {
  productLlmSelectionResolver,
  resetLlmSelectionResolverForTest,
  setLlmSelectionResolver,
} from "../llm/llm-selection.js";
import {
  createRequestLog,
  registerRecordingBackend,
  type RequestLog,
} from "../llm/test-support/recording-llm-backends.js";
import { insertSession } from "./sessions-repository.js";

/**
 * 受入基準（S2）S2-R1（チャット）・S2-R8〜S2-R10c・S2-R12・S2-R13（機能仕様
 * docs/features/llm-provider-abstraction.md クリティカル設計決定 5「S2 の形」
 * ・仮定 A19・A21）: チャットは、事前の確認（従来の位置で解決してクライアントを
 * 作る）と、1 ターン分のスナップショットからの 1 回の解決（送る組）を分ける。
 * 実際に送るバックエンドとモデルは必ず後者の同じ組から決まる。
 *
 * 製品版の解決関数と、名前 `byok-anthropic`・`byok-openai` の記録するバックエンド
 * を登録して行う（実キー・実 API は使わない）。
 */

const env = {};

describe("チャットの送信先は 1 ターン分のスナップショットの選択で決まる（#582 S2）", () => {
  let db: DbPort;
  let raw: Database.Database;
  let hooks: DriverHook[];
  let log: RequestLog;
  let app: ReturnType<typeof createCoreApp>;
  let sessionId: number;

  beforeEach(async () => {
    ({ db, raw, hooks } = await createHookedTestDb());
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
    setLlmSelectionResolver(productLlmSelectionResolver);
    log = createRequestLog();
    app = createCoreApp(db, env, { llmSelectionApi: true });
    sessionId = (await insertSession(db, { type: "adhoc" })).id;
  });

  afterEach(() => {
    raw.close();
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
  });

  function saveSelection(provider: string, model: string): void {
    raw
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('byok_provider', ?), ('byok_model', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(provider, model);
  }

  function clearProvider(): void {
    raw.prepare("DELETE FROM settings WHERE key = 'byok_provider'").run();
  }

  async function postChat(): Promise<Response> {
    return app.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "今日の進め方です" }),
    });
  }

  async function chatOk(): Promise<void> {
    const res = await postChat();
    expect(res.status).toBe(200);
    await res.text();
  }

  function userMessageCount(): number {
    return (
      raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'").get(sessionId) as {
        n: number;
      }
    ).n;
  }

  /** 1 ターンの間、`isTarget` に合う最初の読み出しの直後に `interrupt` を 1 回だけ起動する。 */
  function interruptAfterFirstTurnRead(isTarget: (sql: string) => boolean, interrupt: () => Promise<Response>) {
    let turnStarted = false;
    let injected: Promise<Response> | undefined;
    hooks.push({
      matches: (sql) => {
        if (sql.trimStart().startsWith("INSERT INTO activity_events")) {
          turnStarted = true;
          return false;
        }
        return turnStarted && injected === undefined && isTarget(sql);
      },
      after: () => {
        injected = interrupt();
      },
    });
    return () => {
      expect(injected, "割り込みが起動していない").toBeDefined();
      return injected!;
    };
  }

  function putSelectionViaApi(provider: string, model: string): Promise<Response> {
    return Promise.resolve(
      app.request("/api/llm-selection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model }),
      }),
    );
  }

  describe("両方の記録するバックエンドを登録しているとき", () => {
    beforeEach(() => {
      registerRecordingBackend("byok-anthropic", log, {
        // S2-R8 / S2-R13 用: 事前の確認で最初に呼ばれる `createClient` の中で割り込む。
        onCreateClient: () => onAnthropicCreateClient?.(),
      });
      registerRecordingBackend("byok-openai", log);
    });

    let onAnthropicCreateClient: (() => void) | undefined;
    afterEach(() => {
      onAnthropicCreateClient = undefined;
    });

    it("S2-R1: 選択を anthropic・claude-sonnet-5 から openai・gpt-6-luna へ保存し直すと、次のチャットは byok-openai へ gpt-6-luna で送られる", async () => {
      saveSelection("anthropic", "claude-sonnet-5");
      await chatOk();
      expect(log.requests).toEqual([{ backend: "byok-anthropic", model: "claude-sonnet-5" }]);

      saveSelection("openai", "gpt-6-luna");
      log.requests.length = 0;
      await chatOk();

      expect(log.requests).toEqual([{ backend: "byok-openai", model: "gpt-6-luna" }]);
    });

    it("S2-R8: 事前の確認でクライアントを作った直後に選択が保存し直されても、そのターンの要求は byok-openai へ gpt-6-luna で送られ、byok-anthropic には何も送られない", async () => {
      saveSelection("anthropic", "claude-sonnet-5");
      let interrupted = false;
      onAnthropicCreateClient = () => {
        if (interrupted) return;
        interrupted = true;
        saveSelection("openai", "gpt-6-luna");
      };

      await chatOk();

      expect(interrupted, "割り込みが起きていない").toBe(true);
      expect(log.requests).toEqual([{ backend: "byok-openai", model: "gpt-6-luna" }]);
      expect(log.requests.filter((request) => request.backend === "byok-anthropic")).toEqual([]);
    });

    it("S2-R9: 1 ターン分のスナップショットを読んだ直後に選択が保存し直されても、そのターンの要求は byok-anthropic へ claude-sonnet-5 で送られ、byok-openai には何も送られない", async () => {
      saveSelection("anthropic", "claude-sonnet-5");
      const injected = interruptAfterFirstTurnRead(
        (sql) => sql.includes("FROM settings"),
        () => putSelectionViaApi("openai", "gpt-6-luna"),
      );

      await chatOk();
      const saved = await injected();

      // 割り込んだ保存そのものは成功している（割り込みが実際に起きた裏取り）。
      expect(saved.status).toBe(200);
      expect(log.requests).toEqual([{ backend: "byok-anthropic", model: "claude-sonnet-5" }]);
      expect(log.requests.filter((request) => request.backend === "byok-openai")).toEqual([]);
      // 次のターンは保存し直した選択に従う。
      log.requests.length = 0;
      await chatOk();
      expect(log.requests).toEqual([{ backend: "byok-openai", model: "gpt-6-luna" }]);
    });

    it("S2-R10: 選択が未保存のとき、チャットの要求は 500 を返す", async () => {
      const res = await postChat();

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error).toContain("設定");
    });

    it("S2-R10b: 選択が未保存のとき、チャットの要求の利用者の発言は DB に保存されない", async () => {
      await postChat();

      expect(userMessageCount()).toBe(0);
    });

    it("S2-R10c: 選択が未保存のとき、どちらの記録するバックエンドにも要求は送られない", async () => {
      await postChat();

      expect(log.requests).toEqual([]);
      expect([...log.clientsCreated.entries()]).toEqual([]);
    });

    it("S2-R10: 保存値のプロバイダが不正（google）のときも 500 で、どちらへも送られず発言は保存されない", async () => {
      saveSelection("google", "gemini-x");

      const res = await postChat();

      expect(res.status).toBe(500);
      expect(log.requests).toEqual([]);
      expect(userMessageCount()).toBe(0);
    });

    it("S2-R13: クライアントを作った後・1 ターン分のスナップショットを読む前に選択が未保存の状態へ変わると、500 を返し、どちらへも送られない（利用者の発言は保存済みのまま）", async () => {
      saveSelection("anthropic", "claude-sonnet-5");
      onAnthropicCreateClient = clearProvider;

      const res = await postChat();

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(log.requests).toEqual([]);
      expect(userMessageCount()).toBe(1);
    });
  });

  it("S2-R12: byok-anthropic だけを登録し、選択 openai・gpt-6-sol を保存すると、チャットの要求は失敗し、byok-anthropic には何も送られない", async () => {
    registerRecordingBackend("byok-anthropic", log);
    saveSelection("openai", "gpt-6-sol");

    const res = await postChat();

    expect(res.status).toBe(500);
    expect(log.requests).toEqual([]);
    expect([...log.clientsCreated.entries()]).toEqual([]);
  });

  it("A21: 1 ターン分の組が未登録のバックエンドに変わったときも 500 を返し、利用者の発言は保存済みのまま、どこへも送られない", async () => {
    registerRecordingBackend("byok-anthropic", log, {
      onCreateClient: () => saveSelection("openai", "gpt-6-sol"),
    });
    saveSelection("anthropic", "claude-sonnet-5");

    const res = await postChat();

    expect(res.status).toBe(500);
    expect(log.requests).toEqual([]);
    expect(userMessageCount()).toBe(1);
  });
});
