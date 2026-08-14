import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readJsonBody } from "../lib/read-json-body.js";
import { SESSION_TYPES } from "./session.js";
import type { SessionType } from "./session.js";
import {
  createSession,
  endSession,
  findSessionById,
  listSessions,
} from "./sessions-repository.js";
import { validateCreateSessionInput } from "./sessions-validation.js";
import { listMessagesBySessionId } from "./messages-repository.js";
import { registerChatMessageRoute } from "./chat-messages-route.js";
import type { LlmBackend } from "../config.js";
import { generateDailyReport } from "../reports/generate-daily-report.js";

function isValidSessionType(value: string): value is SessionType {
  return SESSION_TYPES.includes(value as SessionType);
}

/**
 * Upper bound (ms) for the daily-report generation step triggered by the
 * evening-end hook below — distinct from the LLM client's own ~120s policy
 * (docs/features/daily-report.md「機能全体の設計 > 夕会終了フック」). Kept
 * separate from `extractEveningSummary`'s own default (no timeout) so only
 * this HTTP-request-bound call site is capped.
 */
const EVENING_END_REPORT_TIMEOUT_MS = 20_000;

/**
 * Best-effort daily-report generation fired when a `type = evening` session
 * transitions from unended to ended for the first time (see call site
 * below for the "first transition" check). Mirrors the
 * `notifications/notification-body.ts` contract: never throws, so the
 * caller (`POST /:id/end`) always returns 200 regardless of generation
 * outcome (prerequisite-not-met / LLM failure / timeout / unexpected
 * exception). Errors are logged with the error's class name only (same
 * convention as `notification-body.ts` / `extract-evening-summary.ts`) to
 * avoid leaking request internals into logs.
 */
async function triggerDailyReportGeneration(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  eveningSessionId: number,
): Promise<void> {
  try {
    await generateDailyReport(db, env, new Date(), {
      eveningSessionId,
      timeoutMs: EVENING_END_REPORT_TIMEOUT_MS,
    });
  } catch (err) {
    console.error(
      "session end: daily report generation failed:",
      err instanceof Error ? err.name : typeof err,
    );
  }
}

/**
 * Creates the sessions sub-router, mounted under `/api/sessions` by the
 * caller. `env`/`llmBackend` have no defaults here — the only caller,
 * `app.ts`, always resolves and passes both explicitly (see
 * `CreateAppOptions.llmBackend`'s doc comment for where the default lives).
 */
export function createSessionsRouter(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  llmBackend: LlmBackend,
): Hono {
  const sessions = new Hono();

  sessions.get("/", (c) => {
    const type = c.req.query("type");
    if (type !== undefined) {
      if (!isValidSessionType(type)) {
        return c.json(
          { error: `type must be one of: ${SESSION_TYPES.join(", ")}` },
          400,
        );
      }
      return c.json(listSessions(db, { type }));
    }

    return c.json(listSessions(db));
  });

  sessions.post("/", async (c) => {
    const body = await readJsonBody(c);

    const result = validateCreateSessionInput(body);
    if (!result.valid) {
      return c.json({ error: result.error }, 400);
    }

    const created = createSession(db, result.data);
    if (!created.ok) {
      return c.json(
        {
          error: "本日の夕会セッションは既に作成されています",
          code: created.code,
        },
        409,
      );
    }

    return c.json(created.session, 201);
  });

  sessions.post("/:id/end", async (c) => {
    const rawId = c.req.param("id");
    const id = Number(rawId);

    // Captured before `endSession` so we can tell a first-time ended_at
    // transition (NULL -> value) apart from a re-end of an already-ended
    // session — `endSession` itself is idempotent and returns the existing
    // row unchanged on re-end (docs/features/daily-report.md「夕会終了
    // フック」). Only the first transition triggers report generation.
    const before = findSessionById(db, id);

    const session = endSession(db, id);
    if (!session) {
      return c.json({ error: `session ${rawId} not found` }, 404);
    }

    const isFirstEnding = before !== undefined && before.ended_at === null;
    if (isFirstEnding && session.type === "evening") {
      // (a) the session's ended_at update above is already committed before
      // (b) this synchronous, request-scoped generation call — the ordering
      // required by the spec's "実行境界" (best-effort: never blocks the
      // 200 response on generation outcome).
      await triggerDailyReportGeneration(db, env, session.id);
    }

    return c.json(session, 200);
  });

  sessions.get("/:id/messages", (c) => {
    const id = Number(c.req.param("id"));

    const session = findSessionById(db, id);
    if (!session) {
      return c.json({ error: `session ${c.req.param("id")} not found` }, 404);
    }

    return c.json(listMessagesBySessionId(db, id));
  });

  registerChatMessageRoute(sessions, db, env, llmBackend);

  return sessions;
}
