import type Database from "better-sqlite3";
import { evaluateRules } from "../detection/rule-engine.js";
import type { DetectionInput, FiringNotification } from "../detection/detection-types.js";
import { listTasks, findTaskById } from "../tasks/tasks-repository.js";
import { listEventsSince } from "../activity/activity-events-repository.js";
import {
  insertNotification,
  listNotificationsSince,
} from "../notifications/notifications-repository.js";
import {
  generateNotificationBody,
  buildFallbackBody,
  type NotificationBodyRequest,
} from "../notifications/notification-body.js";
import { sendNotification, type ExecFileFn } from "../notifications/notifier.js";
import { loadDetectionSettings } from "./detection-settings.js";
import { listTodaysSessionTypes } from "./todays-sessions.js";
import { toNotificationHistory } from "./notification-history.js";
import { mapToNotificationRuleType, toEscalationLevel } from "./rule-type-mapping.js";

/**
 * Lower bound for `listEventsSince` / `listNotificationsSince`: this ticket
 * intentionally reads the full history rather than a rolling window. At MVP
 * data volumes (single local user, SQLite) this is simpler (KISS/YAGNI) than
 * picking a window size that risks excluding a still-relevant signal (e.g. a
 * break with an unusually long user-declared `expected_minutes`). Revisit if
 * `activity_events`/`notifications` growth ever becomes a real performance
 * concern.
 */
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

const DEFAULT_NOTIFICATION_TITLE = "AIボス";

export interface TickDeps {
  db: Database.Database;
  env: NodeJS.ProcessEnv;
  execFile: ExecFileFn;
  /**
   * Notification title. Fixed default (not persona-driven): the persona
   * already shapes the notification *body* via `generateNotificationBody`,
   * and adding a second DB read here for the title alone is not warranted
   * (YAGNI). Explicit assumption — see PR description for #38.
   */
  notificationTitle?: string;
  /**
   * URL to open when the notification is clicked. Left undefined by default:
   * no frontend-origin config (e.g. `WEB_APP_URL`) exists yet in this
   * codebase, and Issue #38's explicit assumptions section does not define
   * one. Wiring click-to-open is deferred to whichever ticket introduces
   * that config (explicit assumption — see PR description for #38).
   */
  notificationUrl?: string;
}

async function buildTickInput(deps: TickDeps, now: Date): Promise<DetectionInput> {
  const settings = loadDetectionSettings(deps.db);
  return {
    now,
    tasks: listTasks(deps.db),
    activityEvents: listEventsSince(deps.db, EPOCH_ISO),
    notifications: toNotificationHistory(listNotificationsSince(deps.db, EPOCH_ISO)),
    settings,
    todaysSessionTypes: listTodaysSessionTypes(deps.db, now),
  };
}

async function processFiring(
  deps: TickDeps,
  firing: FiringNotification,
  now: Date,
): Promise<void> {
  const title = deps.notificationTitle ?? DEFAULT_NOTIFICATION_TITLE;
  const task = firing.taskId !== null ? (findTaskById(deps.db, firing.taskId) ?? null) : null;

  // `notifications.type` intentionally stores the *detection* vocabulary
  // (e.g. "unstarted"), not the notification-body vocabulary it gets mapped
  // to below (e.g. "todo_stall"): the detection engine reads its own history
  // back via `notification-history.ts` and matches on `rule_key`/escalation
  // state, not on `type`, but keeping `type` in the engine's own vocabulary
  // avoids a second, silent rule-type mapping showing up in the DB/logs.
  const bodyRequest: NotificationBodyRequest = {
    ruleType: mapToNotificationRuleType(firing.ruleType),
    escalationLevel: toEscalationLevel(firing.escalationLevel),
    task,
    now,
  };

  // `generateNotificationBody` already documents (and its own try/catch
  // enforces — see that function's body in notification-body.ts) a
  // never-throws contract: any failure of the LLM call itself (missing API
  // key, timeout, empty response, etc.) is already recovered internally via
  // its own fallback template. This try/catch is defense-in-depth for that
  // contract being violated (e.g. a future change to generateNotificationBody,
  // or an unexpected input, throws before/outside its own try). Without this, the
  // notification for this firing would be silently dropped — sending/
  // recording never runs (Issue #205). Falls back to the same generic
  // template logic via the exported `buildFallbackBody` rather than
  // re-deriving fallback copy here (single source of truth).
  let body: string;
  try {
    body = await generateNotificationBody(deps.db, deps.env, bodyRequest);
  } catch (err) {
    // Unlike notification-body.ts's own catch (which guards a Claude API
    // call and therefore only logs the error's class name), anything
    // reaching *this* catch cannot originate from the Claude API — that
    // call is fully wrapped inside generateNotificationBody's own try. So
    // message/stack here is safe to log (same reasoning as runTick's outer
    // catch below) and is worth keeping: it's the only diagnostic trail for
    // a genuine bug in generateNotificationBody reaching production.
    console.error(
      `scheduler firing: notification body generation threw, falling back to template (rule_key=${firing.ruleKey}):`,
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    body = buildFallbackBody(bodyRequest);
  }

  // Record *before* sending (Issue #221). A macOS notification cannot be
  // un-delivered, so the record that suppresses duplicates and tracks
  // escalation state (read back via notification-history.ts) must already be
  // durable at the moment the user can see it. Recording afterwards left a
  // window where a failed `insertNotification` produced "delivered but
  // unrecorded" — and the next tick, seeing no history, would send the very
  // same notification again.
  //
  // This ordering does not change the success path, and it keeps Issue #38's
  // existing contract: the notification is recorded regardless of delivery
  // success (`sendNotification` never throws — it reports delivery failure
  // via its return value instead, see notifier.ts), a failed send is not
  // retried, and if the underlying condition still holds the next tick's
  // escalation interval naturally triggers a re-send. What it changes is the
  // *failure* path: a failed record now means nothing was sent either, so
  // the same natural re-send path covers it instead of the user being
  // notified twice.
  insertNotification(deps.db, {
    type: firing.ruleType,
    rule_key: firing.ruleKey,
    escalation_level: firing.escalationLevel,
    body,
  });

  await sendNotification(
    { title, body, url: deps.notificationUrl },
    { execFile: deps.execFile },
  );
}

async function runTick(deps: TickDeps, now: Date): Promise<void> {
  const input = await buildTickInput(deps, now);
  const firings = evaluateRules(input);

  for (const firing of firings) {
    try {
      await processFiring(deps, firing, now);
    } catch (err) {
      // firing ごとに独立して処理し、1 件の失敗（DB 書き込み等）が同一 tick の
      // 他の発火（別ルール・別タスク・タイムウィンドウ依存の朝会/夕会リマインド）
      // を止めないようにする。Claude API のエラーは generateNotificationBody 内で
      // 捕捉済みのため、ここの message/stack にリクエスト内部情報は含まれない。
      console.error(
        `scheduler firing failed (rule_key=${firing.ruleKey}):`,
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
    }
  }
}

export interface Ticker {
  /**
   * Runs one scheduler evaluation. Skips (logs and returns immediately)
   * if a previous call is still in flight (concurrency guard — Issue #38).
   * Never throws: any error is logged and swallowed so a single bad tick
   * cannot stop the scheduler or crash the server.
   */
  tick(now?: Date): Promise<void>;
}

/**
 * Creates a `Ticker` bound to the given dependencies, with its own
 * concurrency guard state. A fresh ticker should be created once and reused
 * across ticks (in production, once at server startup — see scheduler.ts);
 * tests create one per test to keep guard state isolated.
 */
export function createTicker(deps: TickDeps): Ticker {
  let isRunning = false;

  return {
    async tick(now: Date = new Date()): Promise<void> {
      if (isRunning) {
        console.warn("scheduler tick skipped: the previous tick is still running");
        return;
      }

      isRunning = true;
      try {
        await runTick(deps, now);
      } catch (err) {
        // 毎分無人実行される唯一のエラー出力箇所のため、原因調査に足る
        // message / stack を残す（Claude API のエラーは notification-body 内で
        // 捕捉済みで、ここには到達しない）。
        console.error(
          "scheduler tick failed:",
          err instanceof Error ? (err.stack ?? err.message) : err,
        );
      } finally {
        isRunning = false;
      }
    },
  };
}
