import 'models.dart';

// server/src/detection/detection-types.ts の移植。

const detectionRuleTypes = [
  'unstarted',
  'avoidance',
  'break_overrun',
  'silence',
  'deadline_overdue',
  'morning_meeting',
  'evening_meeting',
  'commitment_missed',
];

/// 今回の評価で発火すべき通知 1 件。文面生成・送信・DB 記録は呼び出し側の責務
class FiringNotification {
  const FiringNotification({required this.ruleType, required this.ruleKey, required this.escalationLevel, required this.taskId});
  final String ruleType;
  final String ruleKey;
  final int escalationLevel;
  final int? taskId;

  @override
  bool operator ==(Object other) =>
      other is FiringNotification && other.ruleType == ruleType && other.ruleKey == ruleKey && other.escalationLevel == escalationLevel && other.taskId == taskId;
  @override
  int get hashCode => Object.hash(ruleType, ruleKey, escalationLevel, taskId);
  @override
  String toString() => '{ruleType: $ruleType, ruleKey: $ruleKey, escalationLevel: $escalationLevel, taskId: $taskId}';
}

class NotificationHistoryEntry {
  const NotificationHistoryEntry({required this.ruleKey, required this.escalationLevel, required this.sentAt});
  final String ruleKey;
  final int escalationLevel;
  final String sentAt;
}

class ThresholdScaleSettings {
  const ThresholdScaleSettings({required this.scale, required this.min, required this.max, required this.fallback});
  final num scale;
  final num min;
  final num max;
  final num fallback;
}

class EscalationIntervalSettings {
  const EscalationIntervalSettings({required this.level1ToLevel2Minutes, required this.level2ToLevel3Minutes, required this.level3RepeatMinutes});
  final num level1ToLevel2Minutes;
  final num level2ToLevel3Minutes;
  final num level3RepeatMinutes;
}

class WorkingHours {
  const WorkingHours({required this.start, required this.end});
  final String start;
  final String end;
}

final timePattern = RegExp(r'^([01]\d|2[0-3]):([0-5]\d)$');

class DetectionSettings {
  const DetectionSettings({
    required this.workingHours,
    required this.unstarted,
    required this.silence,
    required this.breakFallbackMinutes,
    required this.avoidanceWindowMinutes,
    required this.escalation,
    required this.morningMeetingTime,
    required this.eveningMeetingTime,
    required this.dailyNotificationCap,
  });
  final WorkingHours workingHours;
  final ThresholdScaleSettings unstarted;
  final ThresholdScaleSettings silence;
  final num breakFallbackMinutes;
  final num avoidanceWindowMinutes;
  final EscalationIntervalSettings escalation;
  final String morningMeetingTime;
  final String eveningMeetingTime;
  final int dailyNotificationCap;

  /// TS の `{ ...DEFAULT_DETECTION_SETTINGS, x: y }` に相当
  DetectionSettings copyWith({
    WorkingHours? workingHours,
    ThresholdScaleSettings? unstarted,
    ThresholdScaleSettings? silence,
    num? breakFallbackMinutes,
    num? avoidanceWindowMinutes,
    EscalationIntervalSettings? escalation,
    String? morningMeetingTime,
    String? eveningMeetingTime,
    int? dailyNotificationCap,
  }) =>
      DetectionSettings(
        workingHours: workingHours ?? this.workingHours,
        unstarted: unstarted ?? this.unstarted,
        silence: silence ?? this.silence,
        breakFallbackMinutes: breakFallbackMinutes ?? this.breakFallbackMinutes,
        avoidanceWindowMinutes: avoidanceWindowMinutes ?? this.avoidanceWindowMinutes,
        escalation: escalation ?? this.escalation,
        morningMeetingTime: morningMeetingTime ?? this.morningMeetingTime,
        eveningMeetingTime: eveningMeetingTime ?? this.eveningMeetingTime,
        dailyNotificationCap: dailyNotificationCap ?? this.dailyNotificationCap,
      );
}

/// Issue #36「明示的な仮定」セクションの決定値
const defaultDetectionSettings = DetectionSettings(
  workingHours: WorkingHours(start: '09:00', end: '18:00'),
  unstarted: ThresholdScaleSettings(scale: 1.0, min: 15, max: 120, fallback: 60),
  silence: ThresholdScaleSettings(scale: 0.75, min: 20, max: 90, fallback: 45),
  breakFallbackMinutes: 15,
  avoidanceWindowMinutes: 30,
  escalation: EscalationIntervalSettings(level1ToLevel2Minutes: 15, level2ToLevel3Minutes: 10, level3RepeatMinutes: 10),
  morningMeetingTime: '09:00',
  eveningMeetingTime: '18:00',
  dailyNotificationCap: 5,
);

class DetectionInput {
  const DetectionInput({
    required this.now,
    required this.tasks,
    required this.activityEvents,
    required this.notifications,
    required this.settings,
    required this.todaysSessionTypes,
  });
  final DateTime now;
  final List<Task> tasks;
  final List<ActivityEvent> activityEvents;
  final List<NotificationHistoryEntry> notifications;
  final DetectionSettings settings;
  final List<SessionType> todaysSessionTypes;
}
