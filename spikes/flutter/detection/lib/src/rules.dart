import 'detection_types.dart';
import 'due_at.dart';
import 'js_date.dart';
import 'models.dart';
import 'time_utils.dart';

// server/src/detection の各ルール（avoidance / break-overrun / commitment-missed / deadline-overdue /
// escalation / meeting / priority / silence / unstarted）の移植。1 ファイル 1 関数群の構成は TS に揃えずまとめた。

// ---- avoidance.ts ----
const _otherTaskActivityTypes = ['task_start', 'task_update'];

/// 回避検知: 直近 windowMinutes 以内に、最優先タスク以外への task_start / task_update があるか。
bool hasRecentActivityOnOtherTasks(Task topTask, DateTime now, List<ActivityEvent> activityEvents, num windowMinutes) {
  return activityEvents.any((event) {
    if (!_otherTaskActivityTypes.contains(event.type)) return false;
    if (event.taskId == null || event.taskId == topTask.id) return false;
    final minutesAgo = diffInMinutesFromIso(now, event.createdAt);
    return minutesAgo >= 0 && minutesAgo <= windowMinutes;
  });
}

// ---- break-overrun.ts ----
/// 直近の break_start のうち、その後に break_end が記録されていないもの（＝現在休憩中）。
ActivityEvent? getActiveBreak(List<ActivityEvent> activityEvents) {
  final breakStarts = activityEvents.where((e) => e.type == 'break_start').toList();
  final lastBreakStart = latestByTimestamp(breakStarts, (e) => e.createdAt);
  if (lastBreakStart == null) return null;
  final lastBreakStartMs = jsTime(lastBreakStart.createdAt);
  final hasEndedAfter = activityEvents.any((e) => e.type == 'break_end' && jsTime(e.createdAt) > lastBreakStartMs);
  return hasEndedAfter ? null : lastBreakStart;
}

/// 休憩延伸検知: 申告時間（expected_minutes、無ければフォールバック）を超過しているか
bool isBreakOverrun(ActivityEvent activeBreak, DateTime now, num fallbackMinutes) {
  final expectedMinutes = activeBreak.expectedMinutes ?? fallbackMinutes;
  final elapsed = diffInMinutesFromIso(now, activeBreak.createdAt);
  return elapsed > expectedMinutes;
}

// ---- commitment-missed.ts ----
/// 着手の約束の時刻を過ぎても未着手か（猶予 0 分）。
bool hasMissedCommitment(Task task, DateTime now) {
  if (task.status != 'todo') return false;
  if (task.committedStartAt == null) return false;
  return now.millisecondsSinceEpoch >= jsTime(task.committedStartAt!);
}

List<Task> findMissedCommitmentTasks(List<Task> tasks, DateTime now) => tasks.where((t) => hasMissedCommitment(t, now)).toList();

String buildCommitmentMissedRuleKey(Task task) => 'commitment_missed:${task.id}:${task.committedStartAt}:${task.committedAt}';

bool hasNoHistoryForRuleKey(String ruleKey, List<NotificationHistoryEntry> notifications) =>
    !notifications.any((entry) => entry.ruleKey == ruleKey);

// ---- deadline-overdue.ts ----
/// 締切超過検知: due_at を過ぎた未完了（todo / in_progress / paused）タスク。解釈は due_at.dart に集約。
List<Task> findOverdueTasks(List<Task> tasks, DateTime now) {
  return tasks.where((task) {
    if (task.status != 'todo' && task.status != 'in_progress' && task.status != 'paused') return false;
    final dueInstant = toDueAtInstant(task.dueAt);
    if (dueInstant == null) return false;
    return dueInstant < now.millisecondsSinceEpoch;
  }).toList();
}

// ---- escalation.ts ----
const _maxEscalationLevel = 3;

class EscalationResult {
  const EscalationResult(this.escalationLevel);
  final int escalationLevel;
  @override
  bool operator ==(Object other) => other is EscalationResult && other.escalationLevel == escalationLevel;
  @override
  int get hashCode => escalationLevel.hashCode;
  @override
  String toString() => '{escalationLevel: $escalationLevel}';
}

num _intervalForLevel(int currentLevel, EscalationIntervalSettings settings) {
  if (currentLevel <= 1) return settings.level1ToLevel2Minutes;
  if (currentLevel == 2) return settings.level2ToLevel3Minutes;
  return settings.level3RepeatMinutes;
}

NotificationHistoryEntry? _latestEntryFor(String ruleKey, List<NotificationHistoryEntry> notifications) =>
    latestByTimestamp(notifications.where((e) => e.ruleKey == ruleKey).toList(), (e) => e.sentAt);

bool _hasActivitySince(String sentAt, List<ActivityEvent> activityEvents) {
  final sentAtMs = jsTime(sentAt);
  return activityEvents.any((e) => jsTime(e.createdAt) > sentAtMs);
}

/// rule_key ごとの通知履歴・活動シグナルから、今回発火すべきか／どのレベルで発火すべきかを決める。
EscalationResult? resolveEscalation(
  String ruleKey,
  DateTime now,
  List<NotificationHistoryEntry> notifications,
  List<ActivityEvent> activityEvents,
  EscalationIntervalSettings settings,
) {
  final last = _latestEntryFor(ruleKey, notifications);
  if (last == null) return const EscalationResult(1);
  if (_hasActivitySince(last.sentAt, activityEvents)) return const EscalationResult(1);
  final elapsed = diffInMinutesFromIso(now, last.sentAt);
  final interval = _intervalForLevel(last.escalationLevel, settings);
  if (elapsed < interval) return null;
  final next = last.escalationLevel + 1;
  return EscalationResult(next < _maxEscalationLevel ? next : _maxEscalationLevel);
}

// ---- meeting.ts ----
bool _isMeetingTimePassed(DateTime now, String meetingTime) {
  final meetingMinutes = timeStringToMinutes(meetingTime);
  if (meetingMinutes == null) return false;
  final l = now.toLocal();
  return l.hour * 60 + l.minute >= meetingMinutes;
}

/// 朝会・夕会定時通知: 設定時刻を過ぎており、当日その種別のセッションがまだ開始されていないか。
bool isMeetingDue(DateTime now, String meetingTime, String sessionType, List<SessionType> todaysSessionTypes) {
  if (!_isMeetingTimePassed(now, meetingTime)) return false;
  return !todaysSessionTypes.contains(sessionType);
}

String buildMeetingRuleKey(String sessionType, DateTime now, String meetingTime) => '${sessionType}_meeting:${toDateKey(now)}@$meetingTime';

// ---- priority.ts ----
const _priorityRank = {'high': 0, 'medium': 1, 'low': 2};
const _noPriorityRank = 3;
const _maxSafeInteger = 9007199254740991;

int _rank(String? priority) => priority == null ? _noPriorityRank : _priorityRank[priority]!;
int _dueAtRank(String? dueAt) => toDueAtInstant(dueAt) ?? _maxSafeInteger;

/// 最優先タスク: todo/in_progress の中から priority → due_at 昇順（null は最後）→ id 昇順の先頭。
Task? pickTopPriorityTask(List<Task> tasks) {
  final candidates = tasks.where((t) => t.status == 'todo' || t.status == 'in_progress').toList();
  if (candidates.isEmpty) return null;
  candidates.sort((a, b) {
    final p = _rank(a.priority) - _rank(b.priority);
    if (p != 0) return p;
    final d = _dueAtRank(a.dueAt).compareTo(_dueAtRank(b.dueAt));
    if (d != 0) return d;
    return a.id - b.id;
  });
  return candidates.first;
}

// ---- silence.ts ----
ActivityEvent? _getLastActivity(List<ActivityEvent> events) => latestByTimestamp(events, (e) => e.createdAt);

Task? _getInProgressTask(List<ActivityEvent> activityEvents, List<Task> tasks) {
  final taskStarts = activityEvents.where((e) => e.type == 'task_start' && e.taskId != null).toList();
  final lastTaskStart = latestByTimestamp(taskStarts, (e) => e.createdAt);
  if (lastTaskStart == null) return null;
  final matches = tasks.where((t) => t.id == lastTaskStart.taskId);
  if (matches.isEmpty || matches.first.status != 'in_progress') return null;
  return matches.first;
}

num computeSilenceThresholdMinutes(List<ActivityEvent> activityEvents, List<Task> tasks, ThresholdScaleSettings settings) {
  final inProgressTask = _getInProgressTask(activityEvents, tasks);
  if (inProgressTask != null && inProgressTask.estimatedMinutes != null) {
    return clamp(inProgressTask.estimatedMinutes! * settings.scale, settings.min, settings.max);
  }
  return settings.fallback;
}

/// 無音検知: 最後の活動シグナル（全種）から閾値時間が経過しているか。
bool isSilent(DateTime now, List<ActivityEvent> activityEvents, List<Task> tasks, ThresholdScaleSettings settings) {
  final lastActivity = _getLastActivity(activityEvents);
  if (lastActivity == null) return false;
  final threshold = computeSilenceThresholdMinutes(activityEvents, tasks, settings);
  return diffInMinutesFromIso(now, lastActivity.createdAt) >= threshold;
}

// ---- unstarted.ts ----
num computeUnstartedThresholdMinutes(Task task, ThresholdScaleSettings settings) {
  if (task.estimatedMinutes == null) return settings.fallback;
  return clamp(task.estimatedMinutes! * settings.scale, settings.min, settings.max);
}

bool isTopTaskUnstarted(Task task, DateTime now, ThresholdScaleSettings settings) {
  if (task.status != 'todo') return false;
  final threshold = computeUnstartedThresholdMinutes(task, settings);
  return diffInMinutesFromIso(now, task.createdAt) >= threshold;
}
