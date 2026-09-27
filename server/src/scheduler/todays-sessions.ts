import type { Db } from "../db/db-port.js";
import { listSessions } from "../sessions/sessions-repository.js";
import type { SessionType } from "../sessions/session.js";
import { toDateKey } from "../detection/time-utils.js";

/**
 * Returns the distinct session types already started "today" (local date,
 * matching the local-date semantics `toDateKey` already uses elsewhere for
 * the morning/evening meeting rule_key). Used to build the detection
 * engine's `todaysSessionTypes` input.
 */
export async function listTodaysSessionTypes(db: Db, now: Date): Promise<SessionType[]> {
  const todayKey = toDateKey(now);
  const types = new Set<SessionType>();

  for (const session of await listSessions(db)) {
    if (toDateKey(new Date(session.started_at)) === todayKey) {
      types.add(session.type);
    }
  }

  return [...types];
}
