import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listDecisions } from "./decisions-repository.js";
import { listAppealsGroupedByDecisionId } from "./appeals-repository.js";
import { registerAppealsRoute } from "./appeals-route.js";

/**
 * Creates the decisions sub-router, mounted under `/api/decisions` by the
 * caller. `GET /` lists decisions for the decision log screen, each with its
 * `appeals` history attached (Issue #48); direct decision writes still go
 * through the boss's `record_decision` tool (see `boss/decision-tool.ts`) —
 * only appeals-driven revisions are written here.
 *
 * `env` is threaded through to the appeals route (Claude API key
 * resolution), mirroring `createSessionsRouter`'s pattern for the chat route.
 */
export function createDecisionsRouter(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
): Hono {
  const decisions = new Hono();

  decisions.get("/", (c) => {
    const appealsByDecisionId = listAppealsGroupedByDecisionId(db);
    const withAppeals = listDecisions(db).map((decision) => ({
      ...decision,
      appeals: appealsByDecisionId.get(decision.id) ?? [],
    }));
    return c.json(withAppeals);
  });

  registerAppealsRoute(decisions, db, env);

  return decisions;
}
