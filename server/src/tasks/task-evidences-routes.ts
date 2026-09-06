import { Hono } from "hono";
import type { Context } from "hono";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonBody } from "../lib/read-json-body.js";
import { findTaskById } from "./tasks-repository.js";
import {
  countTaskEvidences,
  findTaskEvidenceById,
  listTaskEvidences,
} from "./task-evidences-repository.js";
import { deleteEvidence, saveFileEvidence, saveLinkEvidence } from "./evidence-storage.js";
import {
  isAllowedEvidenceExtension,
  isAllowedEvidenceUrlScheme,
  isEvidenceCountUnderLimit,
  isEvidenceFileSizeAllowed,
} from "./evidence-validation.js";

/**
 * `GET/POST /api/tasks/:id/evidences`・`GET .../:evidenceId/content`・
 * `DELETE .../:evidenceId` の 4 エンドポイント（機能仕様
 * docs/features/completion-evidence-enforcement.md「画面・API設計」）。
 * 判定ロジック（拡張子・サイズ・件数・URLスキーム）は `evidence-validation.ts`
 * を、保存・削除の実処理は `evidence-storage.ts` を呼ぶだけの薄い層に保つ
 * （このファイルで判定ロジックを再実装しない）。
 *
 * `updateTask` の `done` 強制ゲート（決定2）は後続チケット #389 の担当。この
 * ルーターはエビデンス自体の CRUD のみを扱う。
 */

function respondTaskNotFound(c: Context, taskId: number): Response {
  return c.json({ error: `task ${taskId} not found` }, 404);
}

function respondEvidenceNotFound(c: Context, evidenceId: number): Response {
  return c.json({ error: `evidence ${evidenceId} not found` }, 404);
}

/**
 * 決定 1-c-ii: 画像 (`image/*`) と PDF のみ `inline`、それ以外は `attachment`。
 */
function isInlineMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

async function handleAddLinkEvidence(c: Context, db: Database.Database, taskId: number) {
  const body = await readJsonBody(c);
  const url =
    body && typeof body === "object" && "url" in body ? (body as { url: unknown }).url : undefined;

  if (typeof url !== "string" || url.length === 0) {
    return c.json({ error: "url is required" }, 400);
  }
  if (!isAllowedEvidenceUrlScheme(url)) {
    return c.json(
      { error: `URL scheme not allowed: ${url}`, code: "evidence_url_scheme_not_allowed" },
      400,
    );
  }

  const evidence = saveLinkEvidence(db, { taskId, url });
  return c.json(evidence, 201);
}

async function handleAddFileEvidence(
  c: Context,
  db: Database.Database,
  evidenceDir: string,
  taskId: number,
) {
  const formBody = await c.req.parseBody();
  const file = formBody["file"];

  if (!(file instanceof File)) {
    return c.json({ error: "file is required" }, 400);
  }
  if (!isAllowedEvidenceExtension(file.name)) {
    return c.json(
      { error: `extension not allowed: ${file.name}`, code: "evidence_extension_not_allowed" },
      400,
    );
  }

  const data = Buffer.from(await file.arrayBuffer());
  if (!isEvidenceFileSizeAllowed(data.length)) {
    return c.json(
      { error: "evidence file exceeds the 10 MB limit", code: "evidence_file_too_large" },
      400,
    );
  }

  const evidence = saveFileEvidence(db, evidenceDir, {
    taskId,
    originalFilename: file.name,
    data,
  });
  return c.json(evidence, 201);
}

/**
 * Creates the evidences sub-router, mounted at `/api/tasks/:id/evidences` by
 * `tasks-routes.ts` via `tasks.route("/:id/evidences", ...)`. Hono merges
 * path params across `.route()` boundaries, so `c.req.param("id")` resolves
 * to the parent `:id` segment inside this router's own handlers.
 */
export function createTaskEvidencesRouter(db: Database.Database, evidenceDir: string): Hono {
  const evidences = new Hono();

  evidences.get("/", (c) => {
    const taskId = Number(c.req.param("id"));
    const task = findTaskById(db, taskId);
    if (!task) {
      return respondTaskNotFound(c, taskId);
    }
    return c.json(listTaskEvidences(db, taskId));
  });

  evidences.post("/", async (c) => {
    const taskId = Number(c.req.param("id"));
    const task = findTaskById(db, taskId);
    if (!task) {
      return respondTaskNotFound(c, taskId);
    }

    if (!isEvidenceCountUnderLimit(countTaskEvidences(db, taskId))) {
      return c.json(
        { error: "task already has the maximum of 10 evidences", code: "evidence_limit_exceeded" },
        409,
      );
    }

    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      return handleAddFileEvidence(c, db, evidenceDir, taskId);
    }
    return handleAddLinkEvidence(c, db, taskId);
  });

  evidences.get("/:evidenceId/content", (c) => {
    const taskId = Number(c.req.param("id"));
    const evidenceId = Number(c.req.param("evidenceId"));

    const task = findTaskById(db, taskId);
    if (!task) {
      return respondTaskNotFound(c, taskId);
    }

    const evidence = findTaskEvidenceById(db, evidenceId);
    if (!evidence || evidence.task_id !== taskId || evidence.kind !== "file") {
      return respondEvidenceNotFound(c, evidenceId);
    }

    // kind === "file" evidences always have stored_filename/mime_type set
    // (task-evidences-repository.ts's insert contract).
    const mimeType = evidence.mime_type as string;
    const filePath = join(evidenceDir, evidence.stored_filename as string);
    const data = readFileSync(filePath);

    return c.body(data, 200, {
      // 決定 1-c-ii: クライアント申告の MIME ではなく拡張子から導出した値
      // (保存時に既に導出済み = mime_type 列) を配信する。
      "Content-Type": mimeType,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": isInlineMimeType(mimeType) ? "inline" : "attachment",
    });
  });

  evidences.delete("/:evidenceId", (c) => {
    const taskId = Number(c.req.param("id"));
    const evidenceId = Number(c.req.param("evidenceId"));

    const task = findTaskById(db, taskId);
    if (!task) {
      return respondTaskNotFound(c, taskId);
    }

    const evidence = findTaskEvidenceById(db, evidenceId);
    if (!evidence || evidence.task_id !== taskId) {
      return respondEvidenceNotFound(c, evidenceId);
    }

    // 決定5: done のタスクからの削除は拒否する。ステータスを done から戻せば
    // 削除できる（可逆性は保たれる）。
    if (task.status === "done") {
      return c.json(
        { error: "cannot delete evidence from a task that is already done", code: "task_already_done" },
        409,
      );
    }

    deleteEvidence(db, evidenceDir, evidenceId);
    return c.body(null, 204);
  });

  return evidences;
}
