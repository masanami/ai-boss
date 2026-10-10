import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createHookedTestDb } from "../db/test-support/create-test-db.js";
import type { DbPort } from "../db/db-port.js";
import type { DriverHook } from "../db/test-support/hooked-driver.js";
import { insertTask } from "../tasks/tasks-repository.js";
import { UNCONFIRMED_TASKS_SECTION_HEADING } from "../boss/persona-prompt.js";
import { insertDecision } from "../decisions/decisions-repository.js";
import type { Decision } from "../decisions/decision.js";
import type { Session } from "./session.js";

// Issue #618（#597 決定 2 の全数監査の漏れ）: チャット 1 ターンのプロンプト材料を
// 1 つのスナップショットで読み、読み出しの途中に別の流れの保存が割り込んでも新旧を
// 混ぜないことを固定する。代表としてタスクと設定を取り上げる（決定・要約・会話履歴
// などほかの材料は、同じトランザクションの中で読むという構造で持つ）。
// 割り込みのタイミングは hooked driver で SQL 文の直後に固定する（壁時計に頼らない）。

const { createClaudeClientMock, streamBossMessageMock, createBossMessageMock } = vi.hoisted(
  () => ({
    createClaudeClientMock: vi.fn(),
    streamBossMessageMock: vi.fn(),
    // 朝会の作成が起動する開会の一言（createBossMessage）を速く終わらせるためだけに
    // モックする（chat-messages-route.test.ts と同じ理由）。
    createBossMessageMock: vi.fn(),
  }),
);

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    streamBossMessage: streamBossMessageMock,
    createBossMessage: createBossMessageMock,
  };
});

const { createApp } = await import("../app.js");

const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };
// persona-prompt.ts の MENTORING_FLOW_INSTRUCTION の冒頭（非公開定数のため文言で観測する）。
const MENTORING_INSTRUCTION_HEAD = "仕事の進め方のメンタリング:";

describe("POST /api/sessions/:id/messages のプロンプト材料のスナップショット（Issue #618）", () => {
  let db: DbPort;
  let raw: Database.Database;
  let hooks: DriverHook[];
  let app: ReturnType<typeof createApp>;
  let taskId: number;

  beforeEach(async () => {
    ({ db, raw, hooks } = await createHookedTestDb());
    createClaudeClientMock.mockReset();
    streamBossMessageMock.mockReset();
    createBossMessageMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
    createBossMessageMock.mockResolvedValue({ content: [] });
    streamBossMessageMock.mockResolvedValue({ content: [{ type: "text", text: "了解" }] });
    raw
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?), (?, ?)")
      .run("boss_name", "旧ボス", "morning_mentoring_required", "false");
    taskId = (
      await insertTask(db, {
        title: "旧タスク",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: null,
      })
    ).id;
    app = createApp(db, env);
  });

  afterEach(() => {
    raw.close();
  });

  async function createMorningSession(): Promise<Session> {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "morning" }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Session;
  }

  function saveNewSettings(): Promise<Response> {
    return Promise.resolve(
      app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boss_name: "新ボス", morning_mentoring_required: true }),
      }),
    );
  }

  function renameTask(): Promise<Response> {
    return Promise.resolve(
      app.request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "新タスク" }),
      }),
    );
  }

  /**
   * チャットのターンが始まった（発言の活動記録を書いた）後、`isTarget` に合う
   * 最初の読み出しの直後に `interrupt()` を 1 回だけ起動する（await しない。
   * hooked-driver.ts の使い方 3）。起動した要求の Promise を返す。
   */
  function interruptAfterFirstTurnRead(
    isTarget: (sql: string) => boolean,
    interrupt: () => Promise<Response>[],
  ): () => Promise<Response>[] {
    let turnStarted = false;
    let injected: Promise<Response>[] | undefined;
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

  async function postChat(sessionId: number): Promise<void> {
    const res = await app.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "今日の進め方です" }),
    });
    expect(res.status).toBe(200);
    await res.text();
  }

  function lastRequest(): { model: string; system: string } {
    const calls = streamBossMessageMock.mock.calls;
    return calls[calls.length - 1][1] as { model: string; system: string };
  }

  it("設定の読み出しの直後に設定の保存が割り込んでも、ペルソナと朝会の必須メンタリングの判定は同じ（旧い）設定から導かれる", async () => {
    const session = await createMorningSession();
    const injected = interruptAfterFirstTurnRead(
      (sql) => sql.includes("FROM settings"),
      () => [saveNewSettings()],
    );

    await postChat(session.id);
    const [saved] = await Promise.all(injected());

    // 割り込んだ保存そのものは成功している（割り込みが実際に起きた裏取り）。
    expect(saved.status).toBe(200);
    const { system } = lastRequest();
    expect(system).toContain("「旧ボス」");
    expect(system).not.toContain(MENTORING_INSTRUCTION_HEAD);
  });

  it("ターン最初の読み出しの直後にタスクの更新と設定の保存が割り込んでも、タスクと設定は同じ時点の（旧い）状態から読まれる", async () => {
    const session = await createMorningSession();
    const injected = interruptAfterFirstTurnRead(
      (sql) => sql.trimStart().startsWith("SELECT") && (sql.includes("FROM tasks") || sql.includes("FROM settings")),
      () => [renameTask(), saveNewSettings()],
    );

    await postChat(session.id);
    const [renamed, saved] = await Promise.all(injected());

    expect(renamed.status).toBe(200);
    expect(saved.status).toBe(200);
    const { system } = lastRequest();
    expect(system).toContain("旧タスク");
    expect(system).not.toContain("新タスク");
    expect(system).toContain("「旧ボス」");
    expect(system).not.toContain(MENTORING_INSTRUCTION_HEAD);
  });

  // Issue #706（親 #561 決定11・AC-42b）: メンタリング記録を持つタスク id の読み取りも
  // タスク一覧と同じトランザクションの中で同じ時点の状態から行われる。読み取りを
  // トランザクションの前へ出すとタイトルの変更が入り、後へ出すと割り込んだ記録で
  // X が確認済みになって行が消える。
  it("ターン最初の tasks/decisions の読み出しの直後にメンタリング記録の挿入とタイトルの変更が割り込んでも、未確認の判定とタスク一覧は同じ（旧い）状態から読まれる（AC-42b）", async () => {
    // X: 見積もり 30 分・メンタリング記録なしの todo タスク（タイトル変更の対象を X にする）
    raw.prepare("UPDATE tasks SET estimated_minutes = 30 WHERE id = ?").run(taskId);
    const session = await createMorningSession();
    // 記録の挿入は DbPort（直列化層）を通す。raw の接続へ直接書くと、開いている
    // ターンのトランザクションの中に入り込んでしまい「別の流れ」にならない。
    let inserted: Promise<Decision> | undefined;
    const injected = interruptAfterFirstTurnRead(
      (sql) =>
        sql.trimStart().startsWith("SELECT") &&
        (sql.includes("FROM tasks") || sql.includes("FROM decisions")),
      () => {
        inserted = insertDecision(db, {
          session_id: session.id,
          task_id: taskId,
          content: "割り込んだ記録",
          kind: "mentoring",
        });
        return [renameTask()];
      },
    );

    await postChat(session.id);
    const [renamed] = await Promise.all(injected());

    // 割り込んだ 2 つの書き込みはどちらも成功している（割り込みが実際に起きた裏取り）。
    expect((await inserted!).kind).toBe("mentoring");
    expect(renamed.status).toBe(200);
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM decisions WHERE task_id = ? AND kind = 'mentoring'").get(taskId),
    ).toEqual({ n: 1 });
    const { system } = lastRequest();
    expect(system).toContain("旧タスク");
    expect(system).not.toContain("新タスク");
    const start = system.indexOf(UNCONFIRMED_TASKS_SECTION_HEADING);
    expect(start).toBeGreaterThan(-1);
    const end = system.indexOf("\n\n", start);
    const section = end === -1 ? system.slice(start) : system.slice(start, end);
    expect(section.split("\n").some((line) => line.includes(`#${taskId} `))).toBe(true);
  });
});
