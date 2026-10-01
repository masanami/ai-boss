import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../db/test-support/create-test-db.js";
import type { DbPort } from "../db/db-port.js";
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
import { registerRelayBackend } from "../llm/backends/relay-backend.js";
import { describeUsageLimitReached } from "../llm/relay-usage-limit.js";
import type { SecureTransportPort, SecureTransportResponse } from "../llm/secure-transport-port.js";
import { SecureTransportError } from "../llm/secure-transport-port.js";
import { insertSession } from "./sessions-repository.js";

/**
 * 受入基準（S2-S のチャット・S2-G の案内。機能仕様 docs/features/llm-relay-server.md）:
 * 課金経路の選択（`llm_billing_route=plan`）でチャットの要求が `relay` へ送られ、`relay` が
 * 上限到達で失敗したときの SSE の `error` イベントは上限到達の文言になる。
 */

const env = {};
const GENERIC = "ボスの応答中にエラーが発生しました";
const FIXED_NOW = new Date(Date.UTC(2026, 9, 1, 14, 59, 59));

function errorResponse(status: number, body: string): SecureTransportResponse {
  return {
    status,
    headers: {},
    body: (async function* () {
      yield new TextEncoder().encode(body);
    })(),
  };
}

const limitBody = (limit?: string) =>
  JSON.stringify({ type: "error", error: { type: "usage_limit_exceeded", message: "BODY-MARKER", ...(limit ? { limit } : {}) } });

/** SSE の応答本文から `error` イベントの `error` の文字列を取り出す。 */
function sseErrors(text: string): string[] {
  const errors: string[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    if (lines.includes("event: error")) {
      const data = lines.find((line) => line.startsWith("data:"));
      errors.push((JSON.parse(data!.slice(5).trim()) as { error: string }).error);
    }
  }
  return errors;
}

describe("チャットと課金経路・上限到達の案内（#583 S2）", () => {
  let db: DbPort;
  let raw: Database.Database;
  let app: ReturnType<typeof createCoreApp>;
  let sessionId: number;
  let log: RequestLog;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
    setLlmSelectionResolver(productLlmSelectionResolver);
    log = createRequestLog();
    app = createCoreApp(db, env);
    sessionId = (await insertSession(db, { type: "adhoc" })).id;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    raw.close();
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function saveRoute(value: string): void {
    raw
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('llm_billing_route', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(value);
  }

  async function postChat(): Promise<Response> {
    return app.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "今日の進め方です" }),
    });
  }

  it("llm_billing_route=plan を保存すると、アプリを作り直さずに次のチャットの要求は relay へ送られる（BYOK の選択が保存済みでも）", async () => {
    registerRecordingBackend("relay", log);
    registerRecordingBackend("byok-anthropic", log);
    raw.exec("INSERT INTO settings (key, value) VALUES ('byok_provider', 'anthropic'), ('byok_model', 'claude-sonnet-5')");
    const first = await postChat();
    expect(first.status).toBe(200);
    await first.text();
    expect(log.requests).toEqual([{ backend: "byok-anthropic", model: "claude-sonnet-5" }]);

    saveRoute("plan");
    log.requests.length = 0;
    const second = await postChat();
    expect(second.status).toBe(200);
    await second.text();
    expect(log.requests).toEqual([{ backend: "relay", model: "ai-boss-plan-default" }]);
  });

  describe("relay が失敗したとき", () => {
    function registerFailingRelay(failure: () => SecureTransportResponse | never) {
      const sent: string[] = [];
      const transport: SecureTransportPort = async (request) => {
        sent.push(request.destination);
        return failure();
      };
      registerRelayBackend(transport);
      registerRecordingBackend("byok-anthropic", log);
      registerRecordingBackend("byok-openai", log);
      raw.exec("INSERT INTO settings (key, value) VALUES ('byok_provider', 'anthropic'), ('byok_model', 'claude-sonnet-5')");
      saveRoute("plan");
      return sent;
    }

    const cases: Array<[string, string | undefined, "daily" | "monthly" | "unknown"]> = [
      ["1 日の上限", "daily", "daily"],
      ["1 か月の上限", "monthly", "monthly"],
      ["limit 不明", undefined, "unknown"],
    ];

    for (const [label, limit, expectedLimit] of cases) {
      it(`${label}で終わったチャットの SSE の error は、失敗の時点の現在時刻と端末の時間帯の describeUsageLimitReached(${expectedLimit}) の文言と一致する（汎用の文言ではない）`, async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(FIXED_NOW);
        const sent = registerFailingRelay(() => errorResponse(429, limitBody(limit)));

        const res = await postChat();
        const errors = sseErrors(await res.text());

        expect(errors).toEqual([describeUsageLimitReached(expectedLimit, FIXED_NOW)]);
        expect(errors[0]).not.toBe(GENERIC);
        expect(errors[0]).not.toContain("BODY-MARKER");
        // 上限到達の失敗は再試行されず、BYOK へ流れない。
        expect(sent).toEqual(["relay-messages"]);
        expect(log.requests).toEqual([]);
      });
    }

    it("上限到達の時刻は失敗の時点の現在時刻（固定の値ではなく実行時の時計）から計算する（日の境界を越えた時刻では戻る時刻が 1 日進む）", async () => {
      const afterBoundary = new Date(Date.UTC(2026, 9, 2, 0, 0, 0));
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(afterBoundary);
      registerFailingRelay(() => errorResponse(429, limitBody("daily")));
      const errors = sseErrors(await (await postChat()).text());
      expect(errors).toEqual([describeUsageLimitReached("daily", afterBoundary)]);
      expect(errors[0]).not.toBe(describeUsageLimitReached("daily", FIXED_NOW));
    });

    it("上限到達以外の失敗（401・502・connection）のチャットの error は、従来どおり汎用の文言である", async () => {
      const failures: Array<() => SecureTransportResponse> = [
        () => errorResponse(401, JSON.stringify({ error: { type: "authentication_error" } })),
        () => errorResponse(502, JSON.stringify({ error: { type: "api_error" } })),
        () => {
          throw new SecureTransportError("connection");
        },
        () => errorResponse(429, JSON.stringify({ error: { type: "rate_limit_error" } })),
      ];
      for (const [index, failure] of failures.entries()) {
        if (index > 0) {
          resetLlmBackendRegistryForTest();
          raw.exec("DELETE FROM settings");
          log.requests.length = 0;
        }
        vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
        const sent = registerFailingRelay(failure);
        const responsePromise = postChat();
        // 再試行可の失敗は指数バックオフで待つため、偽の時計を進める。
        await vi.advanceTimersByTimeAsync(10_000);
        const text = await (await responsePromise).text();
        vi.useRealTimers();
        expect(sseErrors(text), `failure #${index}`).toEqual([GENERIC]);
        expect(sent.every((destination) => destination === "relay-messages"), `failure #${index}`).toBe(true);
        expect(log.requests).toEqual([]);
      }
    });

    it("上限到達の文言に、BYOK・プラン・API キーを勧める語が含まれない", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FIXED_NOW);
      registerFailingRelay(() => errorResponse(429, limitBody("daily")));
      const [message] = sseErrors(await (await postChat()).text());
      for (const forbidden of ["API キー", "BYOK", "プラン"]) {
        expect(message).not.toContain(forbidden);
      }
    });
  });
});
