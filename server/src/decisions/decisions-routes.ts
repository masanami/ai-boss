import { Hono } from "hono";
import type { Db } from "../db/db-port.js";
import { listDecisions } from "./decisions-repository.js";

/**
 * Creates the decisions sub-router, mounted under `/api/decisions` by the
 * caller. `GET /` lists decisions for the decision log screen; direct
 * decision writes go through the boss's `record_decision` tool (see
 * `boss/decision-tool.ts`) — this router is read-only (#358/#397: the
 * appeals-driven revision write path was removed, being unused — the chat's
 * `record_decision` tool already covers re-litigating a decision).
 */
export function createDecisionsRouter(db: Db): Hono {
  const decisions = new Hono();

  decisions.get("/", async (c) => {
    return c.json(await listDecisions(db));
  });

  return decisions;
}
