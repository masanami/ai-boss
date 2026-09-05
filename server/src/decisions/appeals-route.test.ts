import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { insertTask } from "../tasks/tasks-repository.js";
import {
  insertDecision,
  findDecisionById,
  updateDecisionStatus,
} from "./decisions-repository.js";
import { listAppealsByDecisionId } from "./appeals-repository.js";
import type { Decision } from "./decision.js";
import type { Appeal } from "./appeal.js";
import type { VerdictInput } from "./verdict-tool.js";

const { createClaudeClientMock, requestVerdictMock } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  requestVerdictMock: vi.fn(),
}));

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    requestVerdict: requestVerdictMock,
  };
});

const { createApp } = await import("../app.js");
const { MissingApiKeyError } = await import("../llm/claude-client.js");

interface ErrorBody {
  error: string;
}

interface AppealResponseBody {
  appeal: Appeal;
  decision: Decision;
  revisedDecision?: Decision;
}

function calledWithValidVerdict(data: VerdictInput) {
  return { called: true as const, result: { valid: true as const, data } };
}

function calledWithInvalidVerdict(error: string) {
  return { called: true as const, result: { valid: false as const, error } };
}

function notCalled() {
  return { called: false as const };
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("POST /api/decisions/:id/appeals", () => {
  let db: Database.Database;
  const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    requestVerdictMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
  });

  afterEach(() => {
    db.close();
  });

  function createActiveDecision(): Decision {
    const session = insertSession(db, { type: "adhoc" });
    return insertDecision(db, {
      session_id: session.id,
      content: "資料作成を最優先にする",
      rationale: "締切が近いため",
    });
  }

  async function postAppeal(decisionId: number | string, content?: unknown) {
    const app = createApp(db, env);
    return app.request(`/api/decisions/${decisionId}/appeals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(content === undefined ? { content: "他を優先させてほしい" } : { content }),
    });
  }

  it("returns 404 for a non-existent decision id", async () => {
    const res = await postAppeal(9999);

    expect(res.status).toBe(404);
    const body = await readJson<ErrorBody>(res);
    expect(typeof body.error).toBe("string");
    expect(requestVerdictMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the decision is not active (already revised)", async () => {
    const decision = createActiveDecision();
    updateDecisionStatus(db, decision.id, "revised");

    const res = await postAppeal(decision.id);

    expect(res.status).toBe(409);
    const body = await readJson<ErrorBody>(res);
    expect(typeof body.error).toBe("string");
    expect(requestVerdictMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the decision is withdrawn", async () => {
    const decision = createActiveDecision();
    updateDecisionStatus(db, decision.id, "withdrawn");

    const res = await postAppeal(decision.id);

    expect(res.status).toBe(409);
    expect(requestVerdictMock).not.toHaveBeenCalled();
  });

  it("returns 400 when content is missing", async () => {
    const decision = createActiveDecision();
    const app = createApp(db, env);

    const res = await app.request(`/api/decisions/${decision.id}/appeals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await readJson<ErrorBody>(res);
    expect(typeof body.error).toBe("string");
    expect(requestVerdictMock).not.toHaveBeenCalled();
  });

  // Issue #288: 裁定は現在日時を「出す」側の経路。ラベルの有無だけを見る
  // （表記そのものの検証は persona-prompt.test.ts が持つ）。
  it("includes the current date/time section in the system prompt (#288)", async () => {
    const decision = createActiveDecision();
    requestVerdictMock.mockResolvedValue(
      calledWithValidVerdict({ verdict: "upheld", response: "維持する" }),
    );

    const res = await postAppeal(decision.id);

    expect(res.status).toBe(200);
    expect(requestVerdictMock.mock.calls[0][1].system).toContain("現在日時:");
  });

  it("defaults to the claude-code backend (DEFAULT_LLM_BACKEND, Issue #118) when no llmBackend option is passed to createApp", async () => {
    const decision = createActiveDecision();
    requestVerdictMock.mockResolvedValue(
      calledWithValidVerdict({ verdict: "upheld", response: "維持する" }),
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/decisions/${decision.id}/appeals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "他を優先させてほしい" }),
    });

    expect(res.status).toBe(200);
    expect(createClaudeClientMock).toHaveBeenCalledWith(env, "claude-code");
  });

  it("passes the configured llmBackend (loadConfig 由来) through to createClaudeClient", async () => {
    const decision = createActiveDecision();
    requestVerdictMock.mockResolvedValue(
      calledWithValidVerdict({ verdict: "upheld", response: "維持する" }),
    );
    const app = createApp(db, env, { llmBackend: "claude-code" });

    const res = await app.request(`/api/decisions/${decision.id}/appeals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "他を優先させてほしい" }),
    });

    expect(res.status).toBe(200);
    expect(createClaudeClientMock).toHaveBeenCalledWith(env, "claude-code");
  });

  // クライアント初期化失敗は、他の 500 経路（GENERIC_VERDICT_ERROR_MESSAGE）と
  // 違い `err.message` をそのまま返す**別経路**（appeals-route.ts L107-112）。
  // 唯一の throw 元は `MissingApiKeyError` で、鍵を含まない固定文言のため
  // 設定ミスの原因を利用者へ伝える意図でそのまま返している。GAP-14 が求める
  // 「500 応答の文言契約」はこの経路にも及ぶので、非露出だけでなく文言そのものを
  // 固定する（Codex 指摘 code-1）。文言はリテラルで書く — 定数を import すると
  // 「定数と定数の比較」で恒真になり契約を固定できない（同ファイルの他ケースと同じ作法）。
  it("returns 500 with the initialization error message, without leaking the api key, when the Claude client cannot be created", async () => {
    const decision = createActiveDecision();
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const res = await postAppeal(decision.id);

    expect(res.status).toBe(500);
    const body = await readJson<ErrorBody>(res);
    expect(body.error).toBe(
      "ANTHROPIC_API_KEY is not set. Configure it in server/.env before using the Claude client.",
    );
    expect(body.error).not.toContain(env.ANTHROPIC_API_KEY);
  });

  it("returns 500 with a generic fallback message when the Claude client throws a non-Error value", async () => {
    const decision = createActiveDecision();
    createClaudeClientMock.mockImplementationOnce(() => {
      throw "not an Error instance";
    });

    const res = await postAppeal(decision.id);

    expect(res.status).toBe(500);
    const body = await readJson<ErrorBody>(res);
    expect(body.error).toBe("failed to initialize the Claude client");
  });

  it("returns 500 and makes no DB changes when the Claude call fails", async () => {
    const decision = createActiveDecision();
    requestVerdictMock.mockRejectedValue(
      new Error("connection reset with request id abc123"),
    );

    const res = await postAppeal(decision.id);
    const rawBody = await res.text();

    expect(res.status).toBe(500);
    expect(rawBody).not.toContain("abc123");
    expect(JSON.parse(rawBody) as ErrorBody).toEqual({
      error: "ボスの再裁定中にエラーが発生しました",
    });
    expect(listAppealsByDecisionId(db, decision.id)).toEqual([]);
    expect(findDecisionById(db, decision.id)).toMatchObject({ status: "active" });
  });

  it("returns 500 and makes no DB changes when Claude does not call submit_verdict", async () => {
    const decision = createActiveDecision();
    requestVerdictMock.mockResolvedValue(notCalled());

    const res = await postAppeal(decision.id);
    const body = await readJson<ErrorBody>(res);

    expect(res.status).toBe(500);
    expect(body.error).toBe("ボスの再裁定中にエラーが発生しました");
    expect(listAppealsByDecisionId(db, decision.id)).toEqual([]);
    expect(findDecisionById(db, decision.id)).toMatchObject({ status: "active" });
  });

  it("returns 500 and makes no DB changes when the verdict is invalid", async () => {
    const decision = createActiveDecision();
    requestVerdictMock.mockResolvedValue(
      calledWithInvalidVerdict(`verdict must be one of: upheld, revised`),
    );

    const res = await postAppeal(decision.id);
    const body = await readJson<ErrorBody>(res);

    expect(res.status).toBe(500);
    expect(body.error).toBe("ボスの再裁定中にエラーが発生しました");
    expect(listAppealsByDecisionId(db, decision.id)).toEqual([]);
    expect(findDecisionById(db, decision.id)).toMatchObject({ status: "active" });
  });

  it("returns 500 and makes no DB changes when verdict is revised but revised_content is missing", async () => {
    const decision = createActiveDecision();
    requestVerdictMock.mockResolvedValue(
      calledWithInvalidVerdict("revised_content is required when verdict is 'revised'"),
    );

    const res = await postAppeal(decision.id);
    const body = await readJson<ErrorBody>(res);

    expect(res.status).toBe(500);
    expect(body.error).toBe("ボスの再裁定中にエラーが発生しました");
    expect(listAppealsByDecisionId(db, decision.id)).toEqual([]);
    expect(findDecisionById(db, decision.id)).toMatchObject({ status: "active" });
  });

  it("persists an upheld appeal, keeps the decision active, and returns {appeal, decision}", async () => {
    const decision = createActiveDecision();
    requestVerdictMock.mockResolvedValue(
      calledWithValidVerdict({
        verdict: "upheld",
        response: "検討したが決定は維持する",
      }),
    );

    const res = await postAppeal(decision.id, "他を優先させてほしい");

    expect(res.status).toBe(200);
    const body = await readJson<AppealResponseBody>(res);
    expect(body.appeal).toMatchObject({
      decision_id: decision.id,
      content: "他を優先させてほしい",
      verdict: "upheld",
      response: "検討したが決定は維持する",
    });
    expect(body.decision).toMatchObject({ id: decision.id, status: "active" });
    expect(body.revisedDecision).toBeUndefined();

    const persistedAppeals = listAppealsByDecisionId(db, decision.id);
    expect(persistedAppeals).toHaveLength(1);
    expect(findDecisionById(db, decision.id)).toMatchObject({ status: "active" });
  });

  it("persists a revised appeal, marks the original decision revised, and creates a new active decision", async () => {
    const session = insertSession(db, { type: "adhoc" });
    const task = insertTask(db, {
      title: "資料作成",
      description: null,
      category: "work",
      priority: null,
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: null,
    });
    const decision = insertDecision(db, {
      session_id: session.id,
      task_id: task.id,
      content: "今日中に資料作成を終える",
    });
    requestVerdictMock.mockResolvedValue(
      calledWithValidVerdict({
        verdict: "revised",
        response: "検討の結果、修正する",
        revisedContent: "明日までに資料作成を終える",
        revisedRationale: "進言の内容が妥当なため",
      }),
    );

    const res = await postAppeal(decision.id, "今日は間に合わない");

    expect(res.status).toBe(200);
    const body = await readJson<AppealResponseBody>(res);
    expect(body.appeal).toMatchObject({ verdict: "revised", response: "検討の結果、修正する" });
    expect(body.decision).toMatchObject({ id: decision.id, status: "revised" });
    expect(body.revisedDecision).toMatchObject({
      session_id: session.id,
      task_id: task.id,
      content: "明日までに資料作成を終える",
      rationale: "進言の内容が妥当なため",
      status: "active",
    });

    expect(findDecisionById(db, decision.id)).toMatchObject({ status: "revised" });
    expect(findDecisionById(db, body.revisedDecision!.id)).toMatchObject({
      content: "明日までに資料作成を終える",
      status: "active",
    });
  });

  it("returns 409 and makes no DB changes when the decision stopped being active while the Claude call was in flight (race guard)", async () => {
    const decision = createActiveDecision();
    requestVerdictMock.mockImplementationOnce(async () => {
      // Simulates a second request (or the boss itself) revising the same
      // decision while this request's ~120s Claude round-trip is still
      // pending — the initial active check happened before this point.
      updateDecisionStatus(db, decision.id, "revised");
      return calledWithValidVerdict({ verdict: "upheld", response: "維持する" });
    });

    const res = await postAppeal(decision.id);

    expect(res.status).toBe(409);
    expect(listAppealsByDecisionId(db, decision.id)).toEqual([]);
    expect(findDecisionById(db, decision.id)).toMatchObject({ status: "revised" });
  });

  it("carries a null task_id through to the revised decision when the original decision has no related task", async () => {
    const decision = createActiveDecision();
    expect(decision.task_id).toBeNull();
    requestVerdictMock.mockResolvedValue(
      calledWithValidVerdict({
        verdict: "revised",
        response: "検討の結果、修正する",
        revisedContent: "資料作成は明日に延ばす",
      }),
    );

    const res = await postAppeal(decision.id, "今日は間に合わない");
    const body = await readJson<AppealResponseBody>(res);

    expect(body.revisedDecision).toMatchObject({ task_id: null });
  });

  it("forces submit_verdict via tool_choice and passes only that tool (no task tools)", async () => {
    const decision = createActiveDecision();
    requestVerdictMock.mockResolvedValue(
      calledWithValidVerdict({ verdict: "upheld", response: "維持する" }),
    );

    await postAppeal(decision.id, "他を優先させてほしい");

    expect(requestVerdictMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tools: [expect.objectContaining({ name: "submit_verdict" })],
        toolChoice: { type: "tool", name: "submit_verdict" },
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("資料作成を最優先にする"),
          }),
        ]),
      }),
      "submit_verdict",
      expect.any(Function),
    );
    const callArgs = requestVerdictMock.mock.calls[0][1];
    expect(callArgs.messages[0].content).toContain("他を優先させてほしい");
  });
});

describe("GET /api/decisions with appeals", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("attaches an empty appeals array when a decision has no appeals", async () => {
    const session = insertSession(db, { type: "adhoc" });
    insertDecision(db, { session_id: session.id, content: "決定内容" });
    const app = createApp(db);

    const res = await app.request("/api/decisions");
    const body = await readJson<Array<Decision & { appeals: Appeal[] }>>(res);

    expect(body).toHaveLength(1);
    expect(body[0].appeals).toEqual([]);
  });

  it("attaches each decision's own appeal history", async () => {
    const session = insertSession(db, { type: "adhoc" });
    const decisionA = insertDecision(db, { session_id: session.id, content: "決定A" });
    const decisionB = insertDecision(db, { session_id: session.id, content: "決定B" });

    createClaudeClientMock.mockReturnValue({});
    requestVerdictMock.mockResolvedValue(
      calledWithValidVerdict({ verdict: "upheld", response: "維持する" }),
    );
    const app = createApp(db, { ANTHROPIC_API_KEY: "sk-ant-test-key" });
    await app.request(`/api/decisions/${decisionA.id}/appeals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "決定Aへの進言" }),
    });

    const res = await app.request("/api/decisions");
    const body = await readJson<Array<Decision & { appeals: Appeal[] }>>(res);

    const found = body.find((d) => d.id === decisionA.id)!;
    const foundB = body.find((d) => d.id === decisionB.id)!;
    expect(found.appeals).toHaveLength(1);
    expect(found.appeals[0]).toMatchObject({ content: "決定Aへの進言", verdict: "upheld" });
    expect(foundB.appeals).toEqual([]);
  });
});
