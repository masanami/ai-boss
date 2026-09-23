import 'detection_types.dart';
import 'js_date.dart';
import 'rules.dart';
import 'time_utils.dart';

// server/src/detection/rule-engine.ts の移植。

String _outsideHoursPeriodKey(DateTime now, WorkingHours workingHours) {
  final configuredStart = timeStringToMinutes(workingHours.start);
  final configuredEnd = timeStringToMinutes(workingHours.end);
  final startMinutes = configuredStart != null && configuredEnd != null
      ? configuredStart
      : timeStringToMinutes(defaultDetectionSettings.workingHours.start)!;
  final l = now.toLocal();
  if (l.hour * 60 + l.minute < startMinutes) {
    // 前日のローカル暦日（固定ミリ秒差はサマータイムで壊れるため使わない）
    return toDateKey(DateTime(l.year, l.month, l.day - 1));
  }
  return toDateKey(now);
}

final _outsideHoursPeriodSuffix = RegExp(r':\d{4}-\d{2}-\d{2}$');

int _countSentOnDate(String baseRuleKey, String dateKey, List<NotificationHistoryEntry> notifications) {
  return notifications.where((entry) {
    if (entry.ruleKey.replaceFirst(_outsideHoursPeriodSuffix, '') != baseRuleKey) return false;
    final sent = jsParse(entry.sentAt);
    // JS: toDateKey(Invalid Date) は "NaN-NaN-NaN" で一致しない
    return sent != null && toDateKey(sent) == dateKey;
  }).length;
}

/// サボり検知ルールエンジン（純粋関数）。入力から今回発火すべき通知のリストを決定的に返す。
List<FiringNotification> evaluateRules(DetectionInput input) {
  final now = input.now;
  final tasks = input.tasks;
  final activityEvents = input.activityEvents;
  final notifications = input.notifications;
  final settings = input.settings;
  final todaysSessionTypes = input.todaysSessionTypes;

  final firing = <FiringNotification>[];

  void tryFire(String ruleType, String ruleKey, int? taskId) {
    final escalation = resolveEscalation(ruleKey, now, notifications, activityEvents, settings.escalation);
    if (escalation == null) return;
    firing.add(FiringNotification(ruleType: ruleType, ruleKey: ruleKey, escalationLevel: escalation.escalationLevel, taskId: taskId));
  }

  void fireOnce(String ruleType, String ruleKey, int? taskId) {
    if (!hasNoHistoryForRuleKey(ruleKey, notifications)) return;
    firing.add(FiringNotification(ruleType: ruleType, ruleKey: ruleKey, escalationLevel: 1, taskId: taskId));
  }

  final withinWorkingHours = isWithinWorkingHours(now, settings.workingHours);
  final activeBreak = getActiveBreak(activityEvents);
  final capDateKey = withinWorkingHours ? toDateKey(now) : _outsideHoursPeriodKey(now, settings.workingHours);

  bool hasReachedDailyCap(String baseRuleKey) => _countSentOnDate(baseRuleKey, capDateKey, notifications) >= settings.dailyNotificationCap;

  void tryFireGated(String ruleType, String ruleKey, int? taskId) {
    if (hasReachedDailyCap(ruleKey)) return;
    if (withinWorkingHours) {
      tryFire(ruleType, ruleKey, taskId);
    } else {
      fireOnce(ruleType, '$ruleKey:$capDateKey', taskId);
    }
  }

  if (activeBreak != null && isBreakOverrun(activeBreak, now, settings.breakFallbackMinutes)) {
    tryFireGated('break_overrun', 'break_overrun', null);
  }

  if (activeBreak == null) {
    final topTask = pickTopPriorityTask(tasks);
    if (topTask != null && topTask.committedStartAt == null && isTopTaskUnstarted(topTask, now, settings.unstarted)) {
      final isAvoiding = hasRecentActivityOnOtherTasks(topTask, now, activityEvents, settings.avoidanceWindowMinutes);
      if (isAvoiding) {
        tryFireGated('avoidance', 'avoidance:${topTask.id}', topTask.id);
      } else {
        tryFireGated('unstarted', 'unstarted:${topTask.id}', topTask.id);
      }
    }

    if (isSilent(now, activityEvents, tasks, settings.silence)) {
      tryFireGated('silence', 'silence', null);
    }

    for (final overdueTask in findOverdueTasks(tasks, now)) {
      tryFireGated('deadline_overdue', 'deadline_overdue:${overdueTask.id}', overdueTask.id);
    }
  }

  for (final task in findMissedCommitmentTasks(tasks, now)) {
    final ruleKey = buildCommitmentMissedRuleKey(task);
    if (hasReachedDailyCap(ruleKey)) continue;
    if (withinWorkingHours) {
      tryFire('commitment_missed', ruleKey, task.id);
    } else {
      fireOnce('commitment_missed', ruleKey, task.id);
    }
  }

  void tryFireMeeting(String sessionType, String ruleType, String meetingTime) {
    if (!isMeetingDue(now, meetingTime, sessionType, todaysSessionTypes)) return;
    tryFire(ruleType, buildMeetingRuleKey(sessionType, now, meetingTime), null);
  }

  tryFireMeeting('morning', 'morning_meeting', settings.morningMeetingTime);
  tryFireMeeting('evening', 'evening_meeting', settings.eveningMeetingTime);

  return firing;
}
