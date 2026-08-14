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
} from "./sessions-repository.js";
import { validateCreateSessionInput } from "./sessions-validation.js";
import { listMessagesBySessionId } from "./messages-repository.js";
import { registerChatMessageRoute } from "./chat-messages-route.js";
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

  sessions.post("/:id/end", (c) => {
    const rawId = c.req.param("id");
    const id = Number(rawId);

    const session = endSession(db, id);
    if (!session) {
      return c.json({ error: `session ${rawId} not found` }, 404);
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
