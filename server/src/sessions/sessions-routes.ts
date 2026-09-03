import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readJsonBody } from "../lib/read-json-body.js";
import { SESSION_TYPES } from "./session.js";
import type { Session, SessionType } from "./session.js";
import {
  createSession,
  endSession,
  findSessionById,
  listSessions,
  updateSessionSummary,
} from "./sessions-repository.js";
import { validateCreateSessionInput } from "./sessions-validation.js";
import { insertMessage, listMessagesBySessionId } from "./messages-repository.js";
import { registerChatMessageRoute } from "./chat-messages-route.js";
import { generateSessionSummary } from "./session-summary.js";
import { generateMeetingOpening, shouldGenerateMeetingOpening } from "./meeting-opening.js";
import type { LlmBackend } from "../config.js";
import { generateDailyReport } from "../reports/generate-daily-report.js";

function isValidSessionType(value: string): value is SessionType {
  return SESSION_TYPES.includes(value as SessionType);
}

/**
 * Upper bound (ms) for the daily-report generation step triggered by the
 * evening-end hook below — distinct from the LLM client's own ~120s policy
 * (夕会終了フック). Kept
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
 * Best-effort meeting-opening generation (Issue #271, 機能仕様
 * docs/features/meeting-start-announcement.md 判断1〜4), fired synchronously
 * as part of `POST /api/sessions` for morning/evening sessions only.
 *
 * Idempotency (AC-6) is guarded by {@link shouldGenerateMeetingOpening}'s
 * "target session has zero messages" check rather than "the session was
 * just created": `sessions-repository.ts`'s `createSession` only enforces a
 * once-per-day limit for `evening` sessions, so a morning session can be
 * created more than once per day and a naive "just created" guard would not
 * actually protect against duplicate generation if this trigger were ever
 * invoked more than once for the same row (defense in depth, mirrors
 * `POST /:id/end`'s `session.summary === null` guard above — 決まったやり方
 * を増やさない).
 *
 * Never throws: `generateMeetingOpening` already never throws (its own
 * contract, boss-comment.ts と同じ), so the try/catch here only guards
 * against a failure in `insertMessage` itself — either way, this function
 * must not turn `POST /api/sessions` into anything but 201 (AC-4).
 */
async function triggerMeetingOpening(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  session: Session,
): Promise<void> {
  const existingMessageCount = listMessagesBySessionId(db, session.id).length;
  if (!shouldGenerateMeetingOpening(session.type, existingMessageCount)) {
    return;
  }
  try {
    const result = await generateMeetingOpening(db, env, new Date(), session.type);
    insertMessage(db, { session_id: session.id, role: "boss", content: result.text });
  } catch (err) {
    console.error(
      "session create: meeting opening generation failed:",
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

    // Issue #271 (AC-1/AC-2): fires the meeting-opening line for morning/
    // evening sessions before responding. Awaited (not fire-and-forget) so
    // the message is guaranteed persisted by the time the client re-fetches
    // — same synchronous-side-effect precedent as POST /:id/end's summary
    // generation below. Never affects the response: see
    // triggerMeetingOpening's own doc comment for why it never throws.
    await triggerMeetingOpening(db, env, created.session);

    return c.json(created.session, 201);
  });

  // Ending a session drives two independent, best-effort side effects, both
  // awaited before the response (no fire-and-forget):
  //
  // 1. Issue #96 — session summary. Synchronous rather than fire-and-forget,
  //    mirroring `dashboard-routes.ts`'s `await getOrGenerateBossComment(...)`
  //    precedent of an in-request LLM call. This makes AC-1 ("ending saves a
  //    summary") deterministically testable at the route layer, at the cost
  //    of the end button taking a few extra seconds to respond (explicit
  //    trade-off, see the Issue #96 PR description).
  // 2. Issue #100 — daily report generation for evening sessions
  //    (夕会終了フック).
  //
  // Their guards are deliberately *different* conditions and must not be
  // collapsed into one: the summary is suppressed by `summary !== null`
  // (don't re-generate an existing summary), while the report fires only on
  // the `ended_at` NULL -> value first transition (re-ending must not re-run
  // the LLM call and UPSERT). A session can satisfy one and not the other.
  sessions.post("/:id/end", async (c) => {
    const rawId = c.req.param("id");
    const id = Number(rawId);

    // Captured before `endSession` so we can tell a first-time ended_at
    // transition (NULL -> value) apart from a re-end of an already-ended
    // session — `endSession` itself is idempotent and returns the existing
    // row unchanged on re-end (夕会終了フックは初回の
    // `ended_at` 遷移でのみ発火する). Only the first transition triggers
    // report generation.
    const before = findSessionById(db, id);

    const session = endSession(db, id);
    if (!session) {
      return c.json({ error: `session ${rawId} not found` }, 404);
    }

    const isFirstEnding = before !== undefined && before.ended_at === null;

    // The row returned to the client. Starts as the just-ended session and is
    // replaced by the summary-bearing row if step 1 stores one — the daily
    // report (step 2) writes to `daily_reports`, never to `sessions`, so it
    // never affects what we return.
    let responseSession = session;

    // 1. Session summary (Issue #96).
    //
    // adhoc sessions are never summarized (decision 3, Issue #96 — no natural
    // "end" trigger in the UI for them). Sessions that already carry a
    // summary skip generation: re-ending must not re-generate (avoids a
    // redundant LLM call on idempotent re-end calls).
    //
    // This pre-check is an optimization, not the overwrite guard: two
    // concurrent requests can both read `summary === null` here and both
    // generate. The authoritative guard is the `WHERE summary IS NULL`
    // compare-and-set inside `updateSessionSummary`, whose returned row is
    // the stored one whether this call won or lost the race.
    if (session.type !== "adhoc" && session.summary === null) {
      const summary = await generateSessionSummary(db, env, llmBackend, id);
      if (summary !== null) {
        const updated = updateSessionSummary(db, id, summary);
        if (updated) {
          responseSession = updated;
        }
      }
    }

    // 2. Daily report (Issue #100). Runs after the summary so this route keeps
    // a single exit point and still returns the summary-bearing row; the two
    // steps are otherwise independent (the report's 3-value extraction reads
    // the evening conversation messages directly and does not consult
    // `sessions.summary`, so neither ordering changes its output).
    //
    // (a) the session's ended_at update above is already committed before
    // (b) this synchronous, request-scoped generation call — the ordering
    // required by the spec's "実行境界" (best-effort). Note this call is
    // awaited: the 200 response waits for generation to finish (or the
    // 20s timeout above), it just never *fails* on generation's outcome —
    // `triggerDailyReportGeneration` swallows all errors so a bad
    // generation never turns this response into a non-200.
    if (isFirstEnding && session.type === "evening") {
      await triggerDailyReportGeneration(db, env, session.id);
    }

    return c.json(responseSession, 200);
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
