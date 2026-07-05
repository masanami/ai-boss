import type { Task } from "../tasks/task.js";
import type { ActivityEvent } from "../activity/activity-event.js";
import type { SessionType } from "../sessions/session.js";

/**
 * サボり検知ルールエンジン（純粋関数）の入出力型。
 * DB リポジトリへの依存は持たない。DB 行 → この plain data への変換は
 * 呼び出し側（スケジューラ統合チケット #38）の責務。
 */

export const DETECTION_RULE_TYPES = [
  "unstarted",
  "avoidance",
  "break_overrun",
  "silence",
  "deadline_overdue",
  "morning_meeting",
  "evening_meeting",
] as const;
export type DetectionRuleType = (typeof DETECTION_RULE_TYPES)[number];

/** 今回の評価で発火すべき通知 1 件。文面生成・送信・DB 記録は呼び出し側の責務 */
export interface FiringNotification {
  ruleType: DetectionRuleType;
  /** 重複送信防止・エスカレーション状態のキー（例: "unstarted:12"） */
  ruleKey: string;
  escalationLevel: number;
  /** ルールが特定タスクに紐づかない場合（無音・休憩延伸等）は null */
  taskId: number | null;
}

/**
 * notifications テーブルの履歴のうち、検知エンジンが必要とする最小限のフィールド
 * （plain data。DB 行の snake_case → camelCase への変換は呼び出し側の責務）
 */
export interface NotificationHistoryEntry {
  ruleKey: string;
  escalationLevel: number;
  /** ISO8601 文字列 */
  sentAt: string;
}

/** estimated_minutes ベースで閾値をスケールさせるための係数・クランプ範囲・フォールバック */
export interface ThresholdScaleSettings {
  /** estimated_minutes に掛ける係数 */
  scale: number;
  /** クランプ下限（分） */
  min: number;
  /** クランプ上限（分） */
  max: number;
  /** estimated_minutes 未確認時のフォールバック（分） */
  fallback: number;
}

export interface EscalationIntervalSettings {
  /** L1 発火後、L2 に上がるまでの無活動時間（分） */
  level1ToLevel2Minutes: number;
  /** L2 発火後、L3 に上がるまでの無活動時間（分） */
  level2ToLevel3Minutes: number;
  /** L3 到達後、再通知までの間隔（分） */
  level3RepeatMinutes: number;
}

export interface WorkingHours {
  /** "HH:mm" 形式（例: "09:00"） */
  start: string;
  /** "HH:mm" 形式（例: "18:00"）。排他的境界 */
  end: string;
}

export interface DetectionSettings {
  workingHours: WorkingHours;
  unstarted: ThresholdScaleSettings;
  silence: ThresholdScaleSettings;
  /** 休憩の申告時間（expected_minutes）が無いときのフォールバック（分） */
  breakFallbackMinutes: number;
  /** 回避検知: 他タスクへの活動を「直近」とみなす窓（分） */
  avoidanceWindowMinutes: number;
  escalation: EscalationIntervalSettings;
  /** 朝会の設定時刻 "HH:mm" */
  morningMeetingTime: string;
  /** 夕会の設定時刻 "HH:mm" */
  eveningMeetingTime: string;
}

/** Issue #36「明示的な仮定」セクションの決定値 */
export const DEFAULT_DETECTION_SETTINGS: DetectionSettings = {
  workingHours: { start: "09:00", end: "18:00" },
  unstarted: { scale: 1.0, min: 15, max: 120, fallback: 60 },
  silence: { scale: 0.75, min: 20, max: 90, fallback: 45 },
  breakFallbackMinutes: 15,
  avoidanceWindowMinutes: 30,
  escalation: {
    level1ToLevel2Minutes: 15,
    level2ToLevel3Minutes: 10,
    level3RepeatMinutes: 10,
  },
  morningMeetingTime: "09:00",
  eveningMeetingTime: "18:00",
};

export interface DetectionInput {
  /** 現在時刻。副作用排除のため呼び出し側が注入する（内部で Date.now() を呼ばない） */
  now: Date;
  tasks: Task[];
  activityEvents: ActivityEvent[];
  notifications: NotificationHistoryEntry[];
  settings: DetectionSettings;
  /**
   * 当日すでに開始済みのセッション種別（朝会・夕会の未実施判定に使う）。
   * 「当日」の判定（日付境界）は呼び出し側の責務とし、ここには当日分のみを渡す。
   */
  todaysSessionTypes: SessionType[];
}
