import {
  DEFAULT_DETECTION_SETTINGS,
  type DetectionInput,
  type DetectionRuleType,
  type FiringNotification,
  type WorkingHours,
} from "./detection-types.js";
import { isWithinWorkingHours, timeStringToMinutes, toDateKey } from "./time-utils.js";
import { pickTopPriorityTask } from "./priority.js";
import { resolveEscalation } from "./escalation.js";
import { isTopTaskUnstarted } from "./unstarted.js";
import { hasRecentActivityOnOtherTasks } from "./avoidance.js";
import { getActiveBreak, isBreakOverrun } from "./break-overrun.js";
import { isSilent } from "./silence.js";
import { findOverdueTasks } from "./deadline-overdue.js";
import { buildMeetingRuleKey, isMeetingDue, type MeetingSessionType } from "./meeting.js";
import {
  buildCommitmentMissedRuleKey,
  findMissedCommitmentTasks,
  hasNoHistoryForRuleKey,
} from "./commitment-missed.js";

/**
 * 勤務時間帯の外にある now が属する帯外区間（終業〜翌始業）の開始日を
 * YYYY-MM-DD（ローカル暦日）で返す。work_start < work_end は S1 の読み出し側
 * ガードが保証するため、帯の外の時刻は「当日の work_end 以降」か「当日の
 * work_start 未満」のどちらかしかない。前者は当日に、後者は前日に始まった
 * 区間に属する（0 時をまたいでも同じ区間のまま）。
 */
function outsideHoursPeriodKey(now: Date, workingHours: WorkingHours): string {
  // 形式不正の値は isWithinWorkingHours と同じく既定の勤務時間帯へ倒す
  const startMinutes =
    timeStringToMinutes(workingHours.start) ??
    (timeStringToMinutes(DEFAULT_DETECTION_SETTINGS.workingHours.start) as number);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (nowMinutes < startMinutes) {
    // 前日のローカル暦日（固定ミリ秒差はサマータイムで壊れるため使わない）
    return toDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  }
  return toDateKey(now);
}

/**
 * サボり検知ルールエンジン（純粋関数）。
 * 入力（タスク・活動シグナル・通知履歴・設定・現在時刻）から、今回発火すべき
 * 通知のリストを決定的に返す。LLM 呼び出し・DB アクセス・Date.now() は行わない。
 *
 * ゲート:
 * - 勤務時間帯外: 朝会・夕会定時ルールを除く全ルールがエスカレーションせず、
 *   rule_key ごとに 1 回だけ L1 で発火する。勤務時間帯ゲート下の 5 ルールは
 *   帯外区間（終業〜翌始業）ごとに 1 回、commitment_missed は約束 1 件につき 1 回
 * - 休憩申告中: 休憩延伸・朝会・夕会・着手の約束を除く全ルールを停止
 *
 * commitment_missed の例外は ADR 0004 改訂（2026-09-13）、5 ルールの帯外発火は
 * docs/features/working-hours-intervals.md 決定 9・10 による。
 */
export function evaluateRules(input: DetectionInput): FiringNotification[] {
  const { now, tasks, activityEvents, notifications, settings, todaysSessionTypes } =
    input;

  const firing: FiringNotification[] = [];

  function tryFire(
    ruleType: DetectionRuleType,
    ruleKey: string,
    taskId: number | null,
  ): void {
    const escalation = resolveEscalation(
      ruleKey,
      now,
      notifications,
      activityEvents,
      settings.escalation,
    );
    if (!escalation) return;
    firing.push({ ruleType, ruleKey, escalationLevel: escalation.escalationLevel, taskId });
  }

  // 勤務時間帯外の発火: resolveEscalation を呼ばず、その rule_key の通知履歴が
  // 1 件も無いときだけ L1 で 1 回だけ発火する（段階を上げない・活動シグナルで
  // リセットしない）。
  function fireOnce(
    ruleType: DetectionRuleType,
    ruleKey: string,
    taskId: number | null,
  ): void {
    if (!hasNoHistoryForRuleKey(ruleKey, notifications)) return;
    firing.push({ ruleType, ruleKey, escalationLevel: 1, taskId });
  }

  const withinWorkingHours = isWithinWorkingHours(now, settings.workingHours);
  const activeBreak = getActiveBreak(activityEvents);

  // 勤務時間帯ゲート下の 5 ルール（break_overrun / unstarted / avoidance /
  // silence / deadline_overdue）。帯の中は resolveEscalation をそのまま通し
  // （L1→L2→L3・活動シグナルによる L1 リセット）、帯の外は rule_key の末尾に
  // 帯外区間（終業〜翌始業）の開始日を足して、区間ごとに 1 回だけ発火する
  // （機能仕様 docs/features/working-hours-intervals.md 決定 9・10）。区間の
  // 日付を足すのは、日付を含まない rule_key だと一度鳴ったら二度と鳴らず、
  // 帯の中で積んだ履歴とも衝突するため。
  function tryFireGated(
    ruleType: DetectionRuleType,
    ruleKey: string,
    taskId: number | null,
  ): void {
    if (withinWorkingHours) {
      tryFire(ruleType, ruleKey, taskId);
    } else {
      fireOnce(ruleType, `${ruleKey}:${outsideHoursPeriodKey(now, settings.workingHours)}`, taskId);
    }
  }

  if (activeBreak && isBreakOverrun(activeBreak, now, settings.breakFallbackMinutes)) {
    tryFireGated("break_overrun", "break_overrun", null);
  }

  if (!activeBreak) {
    const topTask = pickTopPriorityTask(tasks);
    // 最優先タスクが着手の約束を持つとき、unstarted・avoidance は評価しない
    // （約束の前後を問わない。次点タスクへの繰り下げもしない。機能仕様
    // docs/features/task-start-commitment.md 決定 4 の 5）
    if (
      topTask &&
      topTask.committed_start_at === null &&
      isTopTaskUnstarted(topTask, now, settings.unstarted)
    ) {
      const isAvoiding = hasRecentActivityOnOtherTasks(
        topTask,
        now,
        activityEvents,
        settings.avoidanceWindowMinutes,
      );
      if (isAvoiding) {
        tryFireGated("avoidance", `avoidance:${topTask.id}`, topTask.id);
      } else {
        tryFireGated("unstarted", `unstarted:${topTask.id}`, topTask.id);
      }
    }

    if (isSilent(now, activityEvents, tasks, settings.silence)) {
      tryFireGated("silence", "silence", null);
    }

    for (const overdueTask of findOverdueTasks(tasks, now)) {
      tryFireGated("deadline_overdue", `deadline_overdue:${overdueTask.id}`, overdueTask.id);
    }
  }

  // 着手の約束の催促は勤務時間帯ゲート・休憩ゲートの外で評価する（機能仕様
  // docs/features/task-start-commitment.md 決定 4・ADR 0004 改訂
  // 2026-09-13）。帯の外は fireOnce で約束 1 件につき 1 回だけ発火する。
  // rule_key が約束の時刻を含み約束ごとに一意なので、暦日は足さない。
  for (const task of findMissedCommitmentTasks(tasks, now)) {
    const ruleKey = buildCommitmentMissedRuleKey(task);
    if (withinWorkingHours) {
      tryFire("commitment_missed", ruleKey, task.id);
    } else {
      fireOnce("commitment_missed", ruleKey, task.id);
    }
  }

  // 朝会・夕会定時通知は勤務時間帯ゲート・休憩ゲートの対象外。
  // `meetingTime` を1回だけ束縛して isMeetingDue / buildMeetingRuleKey の
  // 両方へ渡すことで、両者に別々の実効時刻が渡ってしまう（rule_key が
  // 発火判定と食い違い、履歴の紐付けが静かに壊れる）余地を無くす。
  function tryFireMeeting(
    sessionType: MeetingSessionType,
    ruleType: DetectionRuleType,
    meetingTime: string,
  ): void {
    if (!isMeetingDue(now, meetingTime, sessionType, todaysSessionTypes)) return;
    tryFire(ruleType, buildMeetingRuleKey(sessionType, now, meetingTime), null);
  }
  tryFireMeeting("morning", "morning_meeting", settings.morningMeetingTime);
  tryFireMeeting("evening", "evening_meeting", settings.eveningMeetingTime);

  return firing;
}
