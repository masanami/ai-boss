import { Hono } from "hono";
import type { Context } from "hono";
import type Database from "better-sqlite3";
import { parseDateKey } from "../detection/time-utils.js";
import { findEveningSessionByDateKey } from "../sessions/sessions-repository.js";
import { findDailyReportByDate, listDailyReports } from "./daily-reports-repository.js";
import { generateDailyReport } from "./generate-daily-report.js";

/**
 * `POST /generate` の任意 JSON body（Issue #297）。両方省略時は従来どおり
 * `toDateKey(now)` の夕会を解決する（後方互換を壊さない — 親エージェント
 * 確定のクリティカル設計決定）。
 *
 * - `eveningSessionId`: 対象夕会を id で直接指定する。
 *   `generateDailyReport` の `GenerateDailyReportOptions.eveningSessionId`
 *   （既存の口、Issue #100）へそのまま渡す。
 * - `date`: 対象日を `YYYY-MM-DD`（{@link parseDateKey} と同じローカル暦日の
 *   キー形式）で指定する。ルート側で対象夕会 id へ解決してから同じ
 *   `eveningSessionId` 経由で渡す（新しい解決経路を増やさない）。
 *
 * 両方指定された場合は `eveningSessionId` を優先する（より直接的な指定を
 * 優先する。曖昧な組み合わせ自体をエラーにするほどのユースケースは無い —
 * YAGNI）。
 */
interface GenerateReportRequestBody {
  eveningSessionId?: unknown;
  date?: unknown;
}

type ReadGenerateRequestBodyResult =
  | { ok: true; body: GenerateReportRequestBody }
  | { ok: false };

/**
 * `POST /generate` の body を読む。この関数を独自実装しているのは、共有
 * ヘルパー `../lib/read-json-body.ts` の `readJsonBody` が「body 省略」と
 * 「JSON として解釈不能」を区別せずどちらも `undefined` に丸め、呼び出し元
 * 全員がそれを一律 400 として扱う契約になっているため（他の全ルートは
 * body が必須）。本エンドポイントは body 全体が任意（両パラメータ省略 = 従来
 * の当日解決）なので、「省略」（→ パラメータなし = 200 系の従来経路）と
 * 「送られたが壊れている」（→ 400 `invalid_request`）を区別する必要がある
 * （self-review 指摘: 壊れた body を黙って「今日」の日報生成に読み替えない）。
 */
async function readGenerateRequestBody(c: Context): Promise<ReadGenerateRequestBodyResult> {
  const rawText = await c.req.text();
  if (rawText.trim() === "") {
    return { ok: true, body: {} };
  }
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, body: parsed as GenerateReportRequestBody };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** `POST /generate` のパラメータ不正（400）応答を1箇所に集約する。 */
function respondInvalidRequest(c: Context, error: string): Response {
  return c.json({ error, code: "invalid_request" }, 400);
}

/**
 * `POST /generate` の「対象夕会が無い」（409）応答を1箇所に集約する。
 * `generateDailyReport` 自体の前提条件チェック（未完了・未終了の夕会）と、
 * ルート側の `date` 解決（該当日に夕会が無い）の両方から呼ばれる —
 * どちらも UI からは同じ `evening_session_required` として区別する必要が
 * 無い（ADR 0008 決定2「UI は code で分岐する」）。
 */
function respondEveningSessionRequired(c: Context): Response {
  return c.json(
    { error: "夕会を完了すると日報を生成できます", code: "evening_session_required" },
    409,
  );
}

/**
 * Creates the reports sub-router, mounted under `/api/reports` by the
 * caller (`app.ts`). `env` is threaded through to `generateDailyReport`
 * (Claude client resolution for the "value extraction" step), mirroring
 * `createDashboardRouter`'s pattern: `generateDailyReport` (like
 * `dashboard/boss-comment.ts`) resolves the LLM backend itself via
 * `resolveLlmBackend(env)` rather than taking an explicit `llmBackend`
 * parameter, so this router only needs `env` — not `llmBackend` like
 * `createSessionsRouter`/`createDecisionsRouter` (Issue #109 design
 * decision).
 */
export function createReportsRouter(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
): Hono {
  const reports = new Hono();

  reports.get("/", (c) => {
    return c.json(listDailyReports(db));
  });

  reports.get("/:date", (c) => {
    const date = c.req.param("date");
    const report = findDailyReportByDate(db, date);
    if (!report) {
      return c.json(
        { error: `report for ${date} not found`, code: "report_not_found" },
        404,
      );
    }
    return c.json(report);
  });

  reports.post("/generate", async (c) => {
    const parsedBody = await readGenerateRequestBody(c);
    if (!parsedBody.ok) {
      return respondInvalidRequest(c, "リクエストボディを JSON オブジェクトとして解釈できません");
    }
    const body = parsedBody.body;

    let eveningSessionId: number | undefined;
    if (body.eveningSessionId !== undefined) {
      if (typeof body.eveningSessionId !== "number" || !Number.isInteger(body.eveningSessionId)) {
        return respondInvalidRequest(c, "eveningSessionId は整数で指定してください");
      }
      eveningSessionId = body.eveningSessionId;
    } else if (body.date !== undefined) {
      if (typeof body.date !== "string") {
        return respondInvalidRequest(c, "date は YYYY-MM-DD 形式で指定してください");
      }
      const parsedDate = parseDateKey(body.date);
      if (!parsedDate) {
        return respondInvalidRequest(c, "date は実在する YYYY-MM-DD 形式の日付で指定してください");
      }
      const session = findEveningSessionByDateKey(db, body.date);
      if (!session) {
        return respondEveningSessionRequired(c);
      }
      eveningSessionId = session.id;
    }

    const result = await generateDailyReport(db, env, new Date(), { eveningSessionId });
    if (!result.ok) {
      return respondEveningSessionRequired(c);
    }
    return c.json(result.report, 200);
  });

  return reports;
}
