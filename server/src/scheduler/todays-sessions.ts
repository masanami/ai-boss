import type Database from "better-sqlite3";
import { listSessions } from "../sessions/sessions-repository.js";
import type { SessionType } from "../sessions/session.js";
import { toDateKey } from "../detection/time-utils.js";

/**
 * Returns the distinct session types already started "today" (local date,
 * matching the local-date semantics `toDateKey` already uses elsewhere for
 * the morning/evening meeting rule_key). Used to build the detection
 * engine's `todaysSessionTypes` input.
 */
export function listTodaysSessionTypes(db: Database.Database, now: Date): SessionType[] {
  const todayKey = toDateKey(now);
  const types = new Set<SessionType>();

  for (const session of listSessions(db)) {
    if (toDateKey(new Date(session.started_at)) === todayKey) {
      types.add(session.type);
    }
  }

  return [...types];
}
