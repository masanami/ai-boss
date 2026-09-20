import { Hono } from "hono";
import type { Context } from "hono";
import type Database from "better-sqlite3";
import { readJsonBody } from "../lib/read-json-body.js";
import { parseDateKey, toDateKey } from "../detection/time-utils.js";
import { TIME_PATTERN } from "../detection/detection-types.js";
import { loadDetectionSettings } from "../scheduler/detection-settings.js";
import {
  latestAllowedMeetingTime,
  isAllowedMeetingTime,
  resolveEffectiveMeetingTimes,
  type MeetingType,
  type MeetingTimeDefaults,
} from "./meeting-schedule.js";
import {
  findOverridesByDate,
  upsertOverride,
  deleteOverride,
} from "./meeting-schedule-repository.js";

/**
 * 当日限りの朝会・夕会の時刻変更（#432 /
 * docs/features/today-meeting-time-override.md）の API 層。
 * `GET /api/meeting-schedule/:date` / `PUT /api/meeting-schedule/:date`
 * を提供する（`app.ts` が `/meeting-schedule` にマウント）。
 *
 * `:date` は当日のみ受け付ける（決定5）。書式検証・実在暦日チェックは
 * 既存の `parseDateKey` を再利用し、新しい日付検証ロジックは書かない。
 */

const MEETING_TYPES: readonly MeetingType[] = ["morning", "evening"];

interface MeetingSlotResponse {
  time: string;
  defaultTime: string;
  overridden: boolean;
  latestAllowedTime: string;
}

interface MeetingScheduleResponse {
  date: string;
  morning: MeetingSlotResponse;
  evening: MeetingSlotResponse;
}

function buildMeetingDefaults(db: Database.Database): MeetingTimeDefaults {
  const settings = loadDetectionSettings(db);
  return {
    morning: settings.morningMeetingTime,
    evening: settings.eveningMeetingTime,
  };
}

function buildSlot(defaultTime: string, effectiveTime: string): MeetingSlotResponse {
  return {
    time: effectiveTime,
    defaultTime,
    overridden: effectiveTime !== defaultTime,
    latestAllowedTime: latestAllowedMeetingTime(defaultTime),
  };
}

function buildResponseBody(
  db: Database.Database,
  date: string,
  defaults: MeetingTimeDefaults,
): MeetingScheduleResponse {
  const overrides = findOverridesByDate(db, date);
  const effective = resolveEffectiveMeetingTimes(defaults, overrides);
  return {
    date,
    morning: buildSlot(defaults.morning, effective.morning),
    evening: buildSlot(defaults.evening, effective.evening),
  };
}

function respondInvalidDate(c: Context): Response {
  return c.json(
    { error: "date は YYYY-MM-DD 形式で指定してください", code: "invalid_date" },
    400,
  );
}

function respondNotToday(c: Context): Response {
  return c.json(
    { error: "date には今日の日付を指定してください", code: "not_today" },
    400,
  );
}

function respondInvalidRequest(c: Context, error: string): Response {
  return c.json({ error, code: "invalid_request" }, 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `:date` パスパラメータを検証する。形式不正・実在しない暦日は
 * `invalid_date`、当日でなければ `not_today` として即応答を返す。
 * 検証を通れば `undefined` を返す（呼び出し元はそのまま処理を続ける）。
 */
function validateDateParam(c: Context, dateParam: string): Response | undefined {
  if (!parseDateKey(dateParam)) {
    return respondInvalidDate(c);
  }
  if (dateParam !== toDateKey(new Date())) {
    return respondNotToday(c);
  }
  return undefined;
}

export function createMeetingScheduleRouter(db: Database.Database): Hono {
  const router = new Hono();

  router.get("/:date", (c) => {
    const dateParam = c.req.param("date");
    const dateError = validateDateParam(c, dateParam);
    if (dateError) return dateError;

    const defaults = buildMeetingDefaults(db);
    return c.json(buildResponseBody(db, dateParam, defaults), 200);
  });

  router.put("/:date", async (c) => {
    const dateParam = c.req.param("date");
    const dateError = validateDateParam(c, dateParam);
    if (dateError) return dateError;

    const rawBody = await readJsonBody(c);
    if (!isRecord(rawBody)) {
      return respondInvalidRequest(c, "リクエストボディを JSON オブジェクトとして解釈できません");
    }

    for (const key of Object.keys(rawBody)) {
      if (key !== "morning" && key !== "evening") {
        return respondInvalidRequest(c, `未知のキーです: ${key}`);
      }
    }

    const defaults = buildMeetingDefaults(db);

    type PendingOperation =
      | { type: MeetingType; action: "upsert"; time: string }
      | { type: MeetingType; action: "delete" };
    const operations: PendingOperation[] = [];

    for (const type of MEETING_TYPES) {
      if (!(type in rawBody)) continue;
      const value = rawBody[type];

      if (value === null) {
        operations.push({ type, action: "delete" });
        continue;
      }

      if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
        return c.json(
          {
            error: `${type} の時刻を "HH:mm" の形式または null で指定してください`,
            code: "invalid_time",
          },
          400,
        );
      }

      if (!isAllowedMeetingTime(defaults[type], value)) {
        return c.json(
          {
            error: `${type} の時刻は ${latestAllowedMeetingTime(defaults[type])} より後には設定できません`,
            code: "delay_limit_exceeded",
          },
          400,
        );
      }

      if (value === defaults[type]) {
        operations.push({ type, action: "delete" });
      } else {
        operations.push({ type, action: "upsert", time: value });
      }
    }

    const applyOperations = db.transaction((ops: PendingOperation[]) => {
      for (const op of ops) {
        if (op.action === "delete") {
          deleteOverride(db, dateParam, op.type);
        } else {
          upsertOverride(db, dateParam, op.type, op.time);
        }
      }
    });
    applyOperations(operations);

    return c.json(buildResponseBody(db, dateParam, defaults), 200);
  });

  return router;
}
