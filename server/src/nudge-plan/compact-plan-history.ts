import type { Task } from "../tasks/task.js";
import type { ActivityEvent, ActivityEventType } from "../activity/activity-event.js";
import type { NotificationHistoryEntry } from "../detection/detection-types.js";
import { buildCommitmentMissedRuleKey } from "../detection/commitment-missed.js";

export interface CompactPlanHistoryInput {
  now: Date;
  tasks: Task[];
  activityEvents: ActivityEvent[];
  notifications: NotificationHistoryEntry[];
}

export interface CompactPlanHistoryResult {
  activityEvents: ActivityEvent[];
  notifications: NotificationHistoryEntry[];
}

/** 圧縮の窓の開始（`now` の前日のローカル 0 時。機能仕様 仮定 A7） */
function windowStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
}

/**
 * `planNudges` が読む活動シグナルのうち、圧縮しても結果が変わらない範囲だけを
 * 残す。窓（`now` の前日のローカル 0 時以降）の全件に加えて、種類ごとの最新
 * 1 件と、`task_id` が非 null の `task_start` の最新 1 件を残す（`silence.ts`
 * の `getInProgressTask` は「非 null の task_id を持つ最新の task_start」を見る
 * ため、種類ごとの最新だけでは、その最新が `task_id: null` のとき見落とす）。
 *
 * `escalation.ts`（hasActivitySince＝活動の有無と時刻だけを見る）・
 * `break-overrun.ts`（`getActiveBreak` は break_start / break_end の種類ごとの
 * 最新を見る）・`silence.ts`（`isSilent`/`getInProgressTask`）・
 * `avoidance.ts`（`hasRecentActivityOnOtherTasks` は直近 avoidanceWindowMinutes
 * 分だけを見るため、前日 0 時以降の窓で十分カバーされる）を確認済み。
 *
 * 元の配列の相対順を保つ（filter で抜く）。
 */
function compactActivityEvents(events: ActivityEvent[], now: Date): ActivityEvent[] {
  const windowStartMs = windowStart(now).getTime();
  const keepIds = new Set<number>();

  // 種類ごとの最新1件・task_id非nullのtask_startの最新1件を、履歴全体を
  // 走査する1パスで求める（種類の数だけ配列を作り直す O(types×N) を避ける）。
  // 同時刻の場合は先に現れた方を残す（`latestByTimestamp` の安定ソートと
  // 同じ選び方）。
  const latestOfType = new Map<ActivityEventType, { id: number; ms: number }>();
  let latestTaskStartWithTask: { id: number; ms: number } | undefined;

  for (const event of events) {
    const ms = new Date(event.created_at).getTime();
    if (ms >= windowStartMs) {
      keepIds.add(event.id);
    }

    const currentLatestOfType = latestOfType.get(event.type);
    if (currentLatestOfType === undefined || ms > currentLatestOfType.ms) {
      latestOfType.set(event.type, { id: event.id, ms });
    }

    if (event.type === "task_start" && event.task_id !== null) {
      if (latestTaskStartWithTask === undefined || ms > latestTaskStartWithTask.ms) {
        latestTaskStartWithTask = { id: event.id, ms };
      }
    }
  }

  for (const { id } of latestOfType.values()) keepIds.add(id);
  if (latestTaskStartWithTask) keepIds.add(latestTaskStartWithTask.id);

  return events.filter((event) => keepIds.has(event.id));
}

/**
 * 圧縮後も残す、日付を含まない `rule_key`（決定 1）の対象一覧。タスクに
 * 紐付かない `break_overrun`・`silence` と、現在の未完了タスク（todo /
 * in_progress / paused）の `unstarted`・`avoidance`・`deadline_overdue`・
 * `commitment_missed`（現在の約束のキー。`committed_start_at` /
 * `committed_at` の両方が非 null のときだけ）。完了・中止したタスクや、
 * 約束を持たない・置き直す前のタスクのキーは含めない（決定 1）。
 */
function currentTargetRuleKeys(tasks: Task[]): Set<string> {
  const keys = new Set<string>(["break_overrun", "silence"]);
  for (const task of tasks) {
    if (task.status !== "todo" && task.status !== "in_progress" && task.status !== "paused") {
      continue;
    }
    keys.add(`unstarted:${task.id}`);
    keys.add(`avoidance:${task.id}`);
    keys.add(`deadline_overdue:${task.id}`);
    if (task.committed_start_at !== null && task.committed_at !== null) {
      keys.add(buildCommitmentMissedRuleKey(task));
    }
  }
  return keys;
}

/**
 * `planNudges` が読む送信履歴のうち、圧縮しても結果が変わらない範囲だけを
 * 残す。窓（`now` の前日のローカル 0 時以降）の全件に加えて、窓の外は
 * {@link currentTargetRuleKeys} の対象 `rule_key` ごとの最新 1 件だけを残す
 * （`resolveEscalation` の `latestEntryFor` と同じ、同時刻なら先に現れた方を
 * 残す選び方。履歴全体を 1 パスで走査して求める）。
 *
 * なぜ十分か: 日付を含む `rule_key`（朝会・夕会の例
 * `morning_meeting:2026-09-27@09:00`、勤務時間帯外の例
 * `silence:2026-09-20`）の発火は、日次上限の枠（`countSentOnDate`）・
 * 帯外区間キー・会のキーのいずれも地平線 24 時間の範囲では前日以降の日付
 * しか参照しないため、窓に必ず入る。窓の外に残す必要があるのは、日付を
 * 含まない基底 `rule_key`（エスカレーションが暦日を越えて続きうるもの）
 * だけである。
 *
 * 元の配列の相対順を保つ（filter で抜く）。
 */
function compactNotifications(
  notifications: NotificationHistoryEntry[],
  tasks: Task[],
  now: Date,
): NotificationHistoryEntry[] {
  const windowStartMs = windowStart(now).getTime();
  const targetKeys = currentTargetRuleKeys(tasks);
  const keepIndices = new Set<number>();

  // 対象キーごとに履歴全体を再フィルタ・再ソートする O(targetKeys×N) を
  // 避け、1パスで「対象キーごとの最新1件」を求める（`latestByTimestamp` と
  // 同じ、同時刻は先に現れた方を残す選び方）。
  const latestOfKey = new Map<string, { index: number; ms: number }>();

  notifications.forEach((entry, index) => {
    const ms = new Date(entry.sentAt).getTime();
    if (ms >= windowStartMs) {
      keepIndices.add(index);
      return;
    }
    if (!targetKeys.has(entry.ruleKey)) return;
    const currentLatest = latestOfKey.get(entry.ruleKey);
    if (currentLatest === undefined || ms > currentLatest.ms) {
      latestOfKey.set(entry.ruleKey, { index, ms });
    }
  });

  for (const { index } of latestOfKey.values()) keepIndices.add(index);

  return notifications.filter((_, index) => keepIndices.has(index));
}

/**
 * 計画（`planNudges`）の前に通す入力の圧縮（機能仕様
 * docs/features/scheduled-nudges.md クリティカル設計決定 1）。履歴の長さ
 * （利用日数）によらず結果を変えずに、活動・送信履歴を絞る純粋関数。
 * `tasks`・`now` はそのまま返す（絞る対象は活動・送信履歴のみ）。
 */
export function compactPlanHistory(input: CompactPlanHistoryInput): CompactPlanHistoryResult {
  return {
    activityEvents: compactActivityEvents(input.activityEvents, input.now),
    notifications: compactNotifications(input.notifications, input.tasks, input.now),
  };
}
