import type { Task } from "../tasks/task.js";
import type { ActivityEvent } from "../activity/activity-event.js";
import type { SessionType } from "../sessions/session.js";
import { evaluateRules } from "../detection/rule-engine.js";
import type {
  DetectionInput,
  DetectionSettings,
  FiringNotification,
  NotificationHistoryEntry,
} from "../detection/detection-types.js";
import { toDateKey } from "../detection/time-utils.js";

/**
 * 暦日 1 日分の、検知エンジンへ渡す会の実効時刻・当日セッション種別
 * （`scheduler-tick.ts` の `buildTickInput` が now の暦日について毎回解決して
 * いるものを、地平線に含まれる暦日ごとに先読みして渡す形。機能仕様
 * docs/features/scheduled-nudges.md クリティカル設計決定 1「暦日ごとの入力」）。
 */
export interface DailyDetectionValues {
  morningMeetingTime: string;
  eveningMeetingTime: string;
  sessionTypes: SessionType[];
}

export interface PlanNudgesInput {
  /** 計画の起点時刻。最初の刻みに使う */
  now: Date;
  /** 地平線の終わり（排他的）。この時刻以降の発火は返さない */
  horizonEnd: Date;
  /**
   * 返す予約の件数の上限。S2 では 64（決定 3）から固定の通知 1 件を引いた
   * 63 を基準にしつつ、決定 2 により取り消し待ちの件数だけさらに減らして
   * 渡す想定（本関数はその差し引き後の値をそのまま上限として使うだけで、
   * 差し引きの計算自体は呼び出し側 S2 の責務）。
   */
  maxCount: number;
  tasks: Task[];
  activityEvents: ActivityEvent[];
  notifications: NotificationHistoryEntry[];
  /** `DetectionSettings` から暦日ごとに差し替える 2 フィールドを除いたもの */
  settings: Omit<DetectionSettings, "morningMeetingTime" | "eveningMeetingTime">;
  /** ローカル暦日キー（`toDateKey` の形式）→ その日の会・セッション値 */
  dailyValues: ReadonlyMap<string, DailyDetectionValues>;
}

/** 計画された予約 1 件（検知の発火 ＋ 予約時刻） */
export interface PlannedNudge extends FiringNotification {
  scheduledAt: Date;
}

export interface NudgePlan {
  nudges: PlannedNudge[];
  /** 上限に達して打ち切られたとき、上限で返せなかった最初の発火の予約時刻。打ち切られなければ null */
  truncatedAt: Date | null;
}

/**
 * `after` より後の直近の分の境界を返す。`after` がちょうど分の境界のときは
 * `after + 60秒`（機能仕様 仮定 A2）。
 */
function nextMinuteBoundary(after: Date): Date {
  const MINUTE_MS = 60_000;
  const flooredToMinute = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS;
  return new Date(flooredToMinute + MINUTE_MS);
}

/**
 * `start`（含む）から `endExclusive` の直前の瞬間までに含まれるローカル暦日の
 * 日付キー（`toDateKey` 形式）を重複無く昇順で返す。`planNudges` が実際に
 * 刻みを進める前に、暦日ごとの入力（`dailyValues`）の過不足を検証するために使う
 * （「計算前に例外を投げる」機能仕様 仮定 A4）。
 */
export function enumerateDateKeysInRange(start: Date, endExclusive: Date): string[] {
  if (endExclusive <= start) return [];
  const keys: string[] = [];
  let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const lastIncludedInstant = new Date(endExclusive.getTime() - 1);
  const endCursor = new Date(
    lastIncludedInstant.getFullYear(),
    lastIncludedInstant.getMonth(),
    lastIncludedInstant.getDate(),
  );
  while (cursor.getTime() <= endCursor.getTime()) {
    keys.push(toDateKey(cursor));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }
  return keys;
}

/**
 * `dateKey` に対応する暦日ごとの値を取り出す。無ければ例外を投げる
 * （呼び出し側の契約違反。仮定 A4）。上限打ち切り前の事前検証・刻みループ内の
 * 参照の両方がこの1関数を通ることで、同じ契約チェック・同じメッセージを
 * 2箇所に重複させない。
 */
function requireDailyValues(
  dateKey: string,
  dailyValues: ReadonlyMap<string, DailyDetectionValues>,
): DailyDetectionValues {
  const daily = dailyValues.get(dateKey);
  if (!daily) {
    throw new Error(
      `planNudges: dailyValues に地平線内の暦日 ${dateKey} の値が無い（呼び出し側の契約違反）`,
    );
  }
  return daily;
}

/**
 * 予約時刻を求める計画層（機能仕様 docs/features/scheduled-nudges.md
 * クリティカル設計決定 1）。`now` から `horizonEnd` の直前まで分刻みで
 * `evaluateRules`（検知エンジン。無改変）を呼び、発火を仮の送信履歴として
 * 積みながら進める（`rule-engine.test.ts` の `sweep` と同じ形）。活動は
 * 起きないものとして計算する。
 *
 * 地平線内の暦日が `dailyValues` に欠けていれば、**刻みを1つも進める前に**
 * 例外を投げる（呼び出し側の契約違反。仮定 A4）。件数上限（`maxCount`）による
 * 打ち切りが実際には欠けた暦日へ到達するより先に起きる入力であっても、この
 * 事前検証は打ち切りの有無を先読みせず無条件に例外を投げる（「計算前」の
 * 契約は「実際に参照される暦日だけを検証する」ではない）。
 */
export function planNudges(input: PlanNudgesInput): NudgePlan {
  const { now, horizonEnd, maxCount, tasks, activityEvents, settings, dailyValues } = input;

  for (const dateKey of enumerateDateKeysInRange(now, horizonEnd)) {
    requireDailyValues(dateKey, dailyValues);
  }

  const notifications: NotificationHistoryEntry[] = [...input.notifications];
  const nudges: PlannedNudge[] = [];

  let t = now;
  while (t < horizonEnd) {
    const daily = requireDailyValues(toDateKey(t), dailyValues);

    const detectionInput: DetectionInput = {
      now: t,
      tasks,
      activityEvents,
      notifications,
      settings: {
        ...settings,
        morningMeetingTime: daily.morningMeetingTime,
        eveningMeetingTime: daily.eveningMeetingTime,
      },
      todaysSessionTypes: daily.sessionTypes,
    };

    const firing = evaluateRules(detectionInput);
    for (const f of firing) {
      if (nudges.length >= maxCount) {
        // 呼び出し側が Date を書き換えても計画済みの結果が影響を受けない
        // よう、共有せず複製して返す。
        return { nudges, truncatedAt: new Date(t.getTime()) };
      }
      notifications.push({ ruleKey: f.ruleKey, escalationLevel: f.escalationLevel, sentAt: t.toISOString() });
      nudges.push({ ...f, scheduledAt: new Date(t.getTime()) });
    }

    t = nextMinuteBoundary(t);
  }

  return { nudges, truncatedAt: null };
}
