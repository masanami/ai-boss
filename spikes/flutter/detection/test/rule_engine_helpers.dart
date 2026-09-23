import 'package:aiboss_detection/aiboss_detection.dart';

// rule-engine.test.ts の共通ヘルパ（baseInput・FiringNotification の短縮コンストラクタ）。

final settings = defaultDetectionSettings;
const _unset = Object();

/// TS の `baseInput({ ...overrides })`
DetectionInput baseInput({
  DateTime? now,
  List<Task>? tasks,
  List<ActivityEvent>? activityEvents,
  List<NotificationHistoryEntry>? notifications,
  DetectionSettings? settings,
  List<String>? todaysSessionTypes,
}) =>
    DetectionInput(
      now: now ?? DateTime.parse('2026-07-05T12:00:00'),
      tasks: tasks ?? const [],
      activityEvents: activityEvents ?? const [],
      notifications: notifications ?? const [],
      settings: settings ?? defaultDetectionSettings,
      todaysSessionTypes: todaysSessionTypes ?? const ['morning', 'evening'],
    );

FiringNotification fire(String ruleType, String ruleKey, int level, int? taskId) =>
    FiringNotification(ruleType: ruleType, ruleKey: ruleKey, escalationLevel: level, taskId: taskId);

NotificationHistoryEntry sent(String ruleKey, int level, String sentAt) => NotificationHistoryEntry(ruleKey: ruleKey, escalationLevel: level, sentAt: sentAt);

List<String> ruleTypes(List<FiringNotification> r) => r.map((f) => f.ruleType).toList();

// ignore: unused_element
const unsetMarker = _unset;

/// TS の `Partial<DetectionInput>`（スプレッドで重ねる入力）
class PartialInput {
  const PartialInput({this.now, this.tasks, this.activityEvents, this.notifications, this.settings, this.todaysSessionTypes});
  final DateTime? now;
  final List<Task>? tasks;
  final List<ActivityEvent>? activityEvents;
  final List<NotificationHistoryEntry>? notifications;
  final DetectionSettings? settings;
  final List<String>? todaysSessionTypes;

  /// `{ ...this, ...other }`
  PartialInput merge(PartialInput other) => PartialInput(
        now: other.now ?? now,
        tasks: other.tasks ?? tasks,
        activityEvents: other.activityEvents ?? activityEvents,
        notifications: other.notifications ?? notifications,
        settings: other.settings ?? settings,
        todaysSessionTypes: other.todaysSessionTypes ?? todaysSessionTypes,
      );

  DetectionInput toInput() => baseInput(
        now: now,
        tasks: tasks,
        activityEvents: activityEvents,
        notifications: notifications,
        settings: settings,
        todaysSessionTypes: todaysSessionTypes,
      );
}
