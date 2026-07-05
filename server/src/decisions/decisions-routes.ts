import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listDecisions } from "./decisions-repository.js";

/**
 * Creates the decisions sub-router, mounted under `/api/decisions` by the
 * caller. MVP: read-only listing for the decision log screen (writes go
 * through the boss's `record_decision` tool — see `boss/decision-tool.ts`).
 */
export function createDecisionsRouter(db: Database.Database): Hono {
  const decisions = new Hono();

  decisions.get("/", (c) => {
    return c.json(listDecisions(db));
  });

  return decisions;
}
