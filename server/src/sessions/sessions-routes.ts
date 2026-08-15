import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readJsonBody } from "../lib/read-json-body.js";
import { SESSION_TYPES } from "./session.js";
import type { SessionType } from "./session.js";
import {
  endSession,
  findSessionById,
  insertSession,
  listSessions,
  updateSessionSummary,
} from "./sessions-repository.js";
import { validateCreateSessionInput } from "./sessions-validation.js";
import { listMessagesBySessionId } from "./messages-repository.js";
import { registerChatMessageRoute } from "./chat-messages-route.js";
import { generateSessionSummary } from "./session-summary.js";
import type { LlmBackend } from "../config.js";

function isValidSessionType(value: string): value is SessionType {
  return SESSION_TYPES.includes(value as SessionType);
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

    const session = insertSession(db, result.data);
    return c.json(session, 201);
  });

  // Issue #96: summary generation runs synchronously here (awaited before the
  // response) rather than fire-and-forget, mirroring
  // `dashboard-routes.ts`'s `await getOrGenerateBossComment(...)` precedent
  // of an in-request LLM call. This makes AC-1 ("ending saves a summary")
  // deterministically testable at the route layer, at the cost of the end
  // button taking a few extra seconds to respond (explicit trade-off, see
  // the Issue #96 PR description).
  sessions.post("/:id/end", async (c) => {
    const rawId = c.req.param("id");
    const id = Number(rawId);

    const session = endSession(db, id);
    if (!session) {
      return c.json({ error: `session ${rawId} not found` }, 404);
    }

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
          return c.json(updated, 200);
        }
      }
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
