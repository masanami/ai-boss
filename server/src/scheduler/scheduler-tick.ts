import type Database from "better-sqlite3";
import { evaluateRules } from "../detection/rule-engine.js";
import type { DetectionInput, FiringNotification } from "../detection/detection-types.js";
import { listTasks, findTaskById } from "../tasks/tasks-repository.js";
import { listEventsSince } from "../activity/activity-events-repository.js";
import {
  insertNotification,
  listNotificationsSince,
} from "../notifications/notifications-repository.js";
import { generateNotificationBody } from "../notifications/notification-body.js";
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
  const body = await generateNotificationBody(deps.db, deps.env, {
    ruleType: mapToNotificationRuleType(firing.ruleType),
    escalationLevel: toEscalationLevel(firing.escalationLevel),
    task,
    now,
  });

  // `sendNotification` never throws (it reports delivery failure via its
  // return value instead — see notifier.ts). The notification is recorded
  // regardless of delivery success: Issue #38's explicit assumption is that
  // a failed send is not retried; if the underlying condition still holds,
  // the next tick's escalation interval will naturally trigger a re-send.
  await sendNotification(
    { title, body, url: deps.notificationUrl },
    { execFile: deps.execFile },
  );

  insertNotification(deps.db, {
    type: firing.ruleType,
    rule_key: firing.ruleKey,
    escalation_level: firing.escalationLevel,
    body,
  });
}

async function runTick(deps: TickDeps, now: Date): Promise<void> {
  const input = await buildTickInput(deps, now);
  const firings = evaluateRules(input);

  for (const firing of firings) {
    await processFiring(deps, firing, now);
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
        console.error("scheduler tick failed:", err instanceof Error ? err.name : typeof err);
      } finally {
        isRunning = false;
      }
    },
  };
}
