import { Hono } from "hono";
import type Database from "better-sqlite3";
import { findDailyReportByDate, listDailyReports } from "./daily-reports-repository.js";
import { generateDailyReport } from "./generate-daily-report.js";

/**
 * Creates the reports sub-router, mounted under `/api/reports` by the
 * caller (`app.ts`). `env` is threaded through to `generateDailyReport`
 * (Claude client resolution for the "value extraction" step), mirroring
 * `createDashboardRouter`'s pattern: `generateDailyReport` (like
 * `dashboard/boss-comment.ts`) resolves the LLM backend itself via
 * `resolveLlmBackend(env)` rather than taking an explicit `llmBackend`
 * parameter, so this router only needs `env` — not `llmBackend` like
 * `createSessionsRouter`/`createDecisionsRouter` (Issue #109 design
 * decision).
 */
export function createReportsRouter(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
): Hono {
  const reports = new Hono();

  reports.get("/", (c) => {
    return c.json(listDailyReports(db));
  });

  reports.get("/:date", (c) => {
    const date = c.req.param("date");
    const report = findDailyReportByDate(db, date);
    if (!report) {
      return c.json(
        { error: `report for ${date} not found`, code: "report_not_found" },
        404,
      );
    }
    return c.json(report);
  });

  reports.post("/generate", async (c) => {
    const result = await generateDailyReport(db, env, new Date());
    if (!result.ok) {
      return c.json(
        { error: "夕会を完了すると日報を生成できます", code: result.code },
        409,
      );
    }
    return c.json(result.report, 200);
  });

  return reports;
}
