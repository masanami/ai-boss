import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listDecisions } from "./decisions-repository.js";

/**
 * Creates the decisions sub-router, mounted under `/api/decisions` by the
 * caller. `GET /` lists decisions for the decision log screen; direct
 * decision writes go through the boss's `record_decision` tool (see
 * `boss/decision-tool.ts`) — this router is read-only (#358/#397: the
 * appeals-driven revision write path was removed, being unused — the chat's
 * `record_decision` tool already covers re-litigating a decision).
 */
export function createDecisionsRouter(db: Database.Database): Hono {
  const decisions = new Hono();

  decisions.get("/", (c) => {
    return c.json(listDecisions(db));
  });

  return decisions;
}
