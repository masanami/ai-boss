import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readJsonBody } from "../lib/read-json-body.js";
import {
  insertTask,
  isEvidenceGateBlocking,
  listTasks,
  updateTask,
} from "./tasks-repository.js";
import {
  validateCreateTaskInput,
  validatePatchTaskInput,
} from "./tasks-validation.js";
import { createTaskEvidencesRouter } from "./task-evidences-routes.js";

// 機能仕様 docs/features/completion-evidence-enforcement.md 決定 2 の
// エラー文言。ボスチャット（task-tools.ts）とは別経路だが、同じ code を返す
// （明示的な仮定3: `<主語>_<条件>` 形式）。
const EVIDENCE_REQUIRED_ERROR_MESSAGE =
  "エビデンスが添付されていないため、このタスクを完了にできません";

/**
 * Creates the tasks sub-router, mounted under `/api/tasks` by the caller.
 *
 * `evidenceDir` is threaded through from `app.ts`'s `CreateAppOptions` to the
 * nested evidences router (機能仕様
 * docs/features/completion-evidence-enforcement.md 決定 1-a). It is only
 * read by the evidence file endpoints (`task-evidences-routes.ts`), never by
 * the task CRUD handlers below, so omitting it (as most existing tests that
 * don't touch evidences do) is harmless.
 */
export function createTasksRouter(db: Database.Database, evidenceDir = ""): Hono {
  const tasks = new Hono();

  // Hono merges path params across `.route()` boundaries, so the nested
  // router's handlers can still read `:id` via `c.req.param("id")`
  // (verified directly against this Hono version before relying on it).
  tasks.route("/:id/evidences", createTaskEvidencesRouter(db, evidenceDir));

  tasks.get("/", (c) => {
    return c.json(listTasks(db));
  });

  tasks.post("/", async (c) => {
    const body = await readJsonBody(c);

    const result = validateCreateTaskInput(body);
    if (!result.valid) {
      return c.json({ error: result.error }, 400);
    }

    // 決定 2-h: POST /api/tasks が status: "done" を直接受け付ける「第5の
    // 経路」も、updateTask と同じ共有述語で判定する（関門を2つに増やさない）。
    // taskId: null は「まだ存在しないタスク＝エビデンス件数は常に0」を表す。
    if (
      result.data.status === "done" &&
      isEvidenceGateBlocking(db, {
        taskId: null,
        evidenceRequired: result.data.evidence_required ?? false,
      })
    ) {
      return c.json(
        { error: EVIDENCE_REQUIRED_ERROR_MESSAGE, code: "evidence_required" },
        409,
      );
    }

    const task = insertTask(db, result.data);
    return c.json(task, 201);
  });

  tasks.patch("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await readJsonBody(c);

    const result = validatePatchTaskInput(body);
    if (!result.valid) {
      return c.json({ error: result.error }, 400);
    }

    const updateResult = updateTask(db, id, result.data);
    if (!updateResult.ok) {
      if (updateResult.reason === "not_found") {
        return c.json({ error: `task ${id} not found` }, 404);
      }
      return c.json(
        { error: EVIDENCE_REQUIRED_ERROR_MESSAGE, code: "evidence_required" },
        409,
      );
    }

    return c.json(updateResult.task);
  });

  return tasks;
}
