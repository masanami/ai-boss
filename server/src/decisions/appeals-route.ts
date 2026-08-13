import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { readJsonBody } from "../lib/read-json-body.js";
import { listTasks, findTaskById } from "../tasks/tasks-repository.js";
import {
  listRecentDecisions,
  findDecisionById,
  insertDecision,
  updateDecisionStatus,
} from "./decisions-repository.js";
import { insertAppeal } from "./appeals-repository.js";
import { resolveBossSettings } from "../boss/boss-settings.js";
import { buildPersonaPrompt } from "../boss/persona-prompt.js";
import type { LlmBackend } from "../config.js";
import {
  createClaudeClient,
  requestVerdict,
  type BossLlmClient,
  type VerdictOutcome,
} from "../llm/claude-client.js";
import { validateAppealInput } from "./appeals-validation.js";
import {
  SUBMIT_VERDICT_TOOL,
  parseVerdictToolInput,
  type VerdictInput,
} from "./verdict-tool.js";
import type { Decision } from "./decision.js";
import type { Appeal } from "./appeal.js";

/** Sanitized message surfaced to the client for any Claude-related failure
 * (missing key, request failure, malformed tool response). Never includes
 * raw error details, which may embed request internals — same critical
 * discipline as `chat-messages-route.ts`. */
const GENERIC_VERDICT_ERROR_MESSAGE = "ボスの再裁定中にエラーが発生しました";

/**
 * Thrown (and caught locally) when the decision stopped being `active`
 * between the initial guard check and the write transaction — e.g. a second
 * appeal on the same decision resolved first while this request's Claude
 * round-trip (up to ~120s) was still in flight. Re-checked inside the
 * transaction so the two writes can't race each other.
 */
class DecisionNoLongerActiveError extends Error {}

function buildAppealUserMessage(
  decision: Decision,
  relatedTask: { title: string } | undefined,
  appealContent: string,
): string {
  const lines = [
    "以下の決定に対してユーザーから進言があった。内容を検討し、必ず submit_verdict ツールで裁定を提出せよ。",
    "",
    `対象の決定: ${decision.content}`,
  ];
  if (decision.rationale) {
    lines.push(`決定の根拠: ${decision.rationale}`);
  }
  if (relatedTask) {
    lines.push(`関連タスク: ${relatedTask.title}`);
  }
  lines.push("", `ユーザーの進言: ${appealContent}`);
  return lines.join("\n");
}

/**
 * Registers `POST /:id/appeals` on the given decisions router: a user's
 * objection to a decision, re-adjudicated by the boss (Claude, forced to
 * call `submit_verdict` in a single round — no streaming, no task tools;
 * see the ticket's explicit assumptions).
 *
 * `llmBackend` is threaded down from `loadConfig(env).llmBackend`, with no
 * default here (the default lives at the single `app.ts` boundary — see
 * `CreateAppOptions.llmBackend`'s doc comment).
 */
export function registerAppealsRoute(
  router: Hono,
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  llmBackend: LlmBackend,
): void {
  router.post("/:id/appeals", async (c) => {
    const rawId = c.req.param("id");
    const id = Number(rawId);

    const decision = findDecisionById(db, id);
    if (!decision) {
      return c.json({ error: `decision ${rawId} not found` }, 404);
    }
    if (decision.status !== "active") {
      return c.json(
        {
          error: `decision ${rawId} is not active (status: ${decision.status})`,
        },
        409,
      );
    }

    const body = await readJsonBody(c);
    const validation = validateAppealInput(body);
    if (!validation.valid) {
      return c.json({ error: validation.error }, 400);
    }

    let client: BossLlmClient;
    try {
      client = createClaudeClient(env, llmBackend);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "failed to initialize the Claude client";
      return c.json({ error: message }, 500);
    }

    const tasks = listTasks(db);
    const recentDecisions = listRecentDecisions(db, 5);
    const { model, persona } = resolveBossSettings(db);
    const system = buildPersonaPrompt(persona, {
      tasks,
      recentDecisions,
      now: new Date(),
    });
    const relatedTask =
      decision.task_id !== null ? findTaskById(db, decision.task_id) : undefined;
    const userMessage = buildAppealUserMessage(
      decision,
      relatedTask,
      validation.data.content,
    );

    let verdictOutcome: VerdictOutcome<VerdictInput>;
    try {
      verdictOutcome = await requestVerdict(
        client,
        {
          model,
          system,
          messages: [{ role: "user", content: userMessage }],
          tools: [SUBMIT_VERDICT_TOOL],
          toolChoice: { type: "tool", name: "submit_verdict" },
        },
        "submit_verdict",
        parseVerdictToolInput,
      );
    } catch (err) {
      // Only log the error's class name — see chat-messages-route.ts for the
      // same critical discipline (Claude API errors may embed request
      // internals in `message`).
      console.error(
        "appeal verdict request failed:",
        err instanceof Error ? err.name : typeof err,
      );
      return c.json({ error: GENERIC_VERDICT_ERROR_MESSAGE }, 500);
    }

    if (!verdictOutcome.called) {
      console.error("appeal verdict response did not call submit_verdict");
      return c.json({ error: GENERIC_VERDICT_ERROR_MESSAGE }, 500);
    }

    if (!verdictOutcome.result.valid) {
      console.error("appeal verdict tool input invalid:", verdictOutcome.result.error);
      return c.json({ error: GENERIC_VERDICT_ERROR_MESSAGE }, 500);
    }

    const { verdict, response, revisedContent, revisedRationale } = verdictOutcome.result.data;

    let transactionResult: {
      appeal: Appeal;
      decision: Decision;
      revisedDecision?: Decision;
    };
    try {
      transactionResult = db.transaction(() => {
        // Re-fetch (rather than trust the `decision` read before the Claude
        // round-trip) and re-check `active`: the status may have changed
        // while this request was awaiting Claude (see
        // `DecisionNoLongerActiveError`'s doc comment).
        const current = findDecisionById(db, id);
        if (!current || current.status !== "active") {
          throw new DecisionNoLongerActiveError();
        }

        const insertedAppeal = insertAppeal(db, {
          decision_id: id,
          content: validation.data.content,
          verdict,
          response,
        });

        if (verdict !== "revised") {
          return { appeal: insertedAppeal, decision: current };
        }

        const updated = updateDecisionStatus(db, id, "revised") as Decision;
        const revised = insertDecision(db, {
          session_id: current.session_id,
          task_id: current.task_id,
          content: revisedContent as string,
          rationale: revisedRationale ?? null,
        });
        return { appeal: insertedAppeal, decision: updated, revisedDecision: revised };
      })();
    } catch (err) {
      if (err instanceof DecisionNoLongerActiveError) {
        return c.json(
          { error: `decision ${rawId} is no longer active` },
          409,
        );
      }
      throw err;
    }

    return c.json(transactionResult);
  });
}
