import type {
  DetectionInput,
  DetectionRuleType,
  FiringNotification,
} from "./detection-types.js";
import { isWithinWorkingHours } from "./time-utils.js";
import { pickTopPriorityTask } from "./priority.js";
import { resolveEscalation } from "./escalation.js";
import { isTopTaskUnstarted } from "./unstarted.js";
import { hasRecentActivityOnOtherTasks } from "./avoidance.js";
import { getActiveBreak, isBreakOverrun } from "./break-overrun.js";
import { isSilent } from "./silence.js";
import { findOverdueTasks } from "./deadline-overdue.js";
import { buildMeetingRuleKey, isMeetingDue } from "./meeting.js";

/**
 * サボり検知ルールエンジン（純粋関数）。
 * 入力（タスク・活動シグナル・通知履歴・設定・現在時刻）から、今回発火すべき
 * 通知のリストを決定的に返す。LLM 呼び出し・DB アクセス・Date.now() は行わない。
 *
 * ゲート:
 * - 勤務時間帯外: 朝会・夕会定時ルールを除く全ルールを停止
 * - 休憩申告中: 休憩延伸ルールを除く全ルールを停止
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

  const withinWorkingHours = isWithinWorkingHours(now, settings.workingHours);
  const activeBreak = getActiveBreak(activityEvents);

  if (withinWorkingHours) {
    if (activeBreak && isBreakOverrun(activeBreak, now, settings.breakFallbackMinutes)) {
      tryFire("break_overrun", "break_overrun", null);
    }

    if (!activeBreak) {
      const topTask = pickTopPriorityTask(tasks);
      if (topTask && isTopTaskUnstarted(topTask, now, settings.unstarted)) {
        const isAvoiding = hasRecentActivityOnOtherTasks(
          topTask,
          now,
          activityEvents,
          settings.avoidanceWindowMinutes,
        );
        if (isAvoiding) {
          tryFire("avoidance", `avoidance:${topTask.id}`, topTask.id);
        } else {
          tryFire("unstarted", `unstarted:${topTask.id}`, topTask.id);
        }
      }

      if (isSilent(now, activityEvents, tasks, settings.silence)) {
        tryFire("silence", "silence", null);
      }

      for (const overdueTask of findOverdueTasks(tasks, now)) {
        tryFire("deadline_overdue", `deadline_overdue:${overdueTask.id}`, overdueTask.id);
      }
    }
  }

  // 朝会・夕会定時通知は勤務時間帯ゲート・休憩ゲートの対象外
  if (isMeetingDue(now, settings.morningMeetingTime, "morning", todaysSessionTypes)) {
    tryFire("morning_meeting", buildMeetingRuleKey("morning", now), null);
  }
  if (isMeetingDue(now, settings.eveningMeetingTime, "evening", todaysSessionTypes)) {
    tryFire("evening_meeting", buildMeetingRuleKey("evening", now), null);
  }

  return firing;
}
