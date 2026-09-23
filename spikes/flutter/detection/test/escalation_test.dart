import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';

final escalationSettings = defaultDetectionSettings.escalation;
NotificationHistoryEntry entry(String key, int level, String sentAt) => NotificationHistoryEntry(ruleKey: key, escalationLevel: level, sentAt: sentAt);

void main() {
  group('resolveEscalation', () {
    test('fires at level 1 when there is no notification history', () {
      expect(resolveEscalation('unstarted:1', d('2026-07-05T10:00:00.000Z'), [], [], escalationSettings), const EscalationResult(1));
    });

    test('does not re-fire before the level-1-to-2 interval (15min) has elapsed', () {
      expect(resolveEscalation('unstarted:1', d('2026-07-05T10:14:59.000Z'), [entry('unstarted:1', 1, '2026-07-05T10:00:00.000Z')], [], escalationSettings), isNull);
    });

    test('escalates from level 1 to level 2 exactly at the 15min interval', () {
      expect(resolveEscalation('unstarted:1', d('2026-07-05T10:15:00.000Z'), [entry('unstarted:1', 1, '2026-07-05T10:00:00.000Z')], [], escalationSettings), const EscalationResult(2));
    });

    test('escalates from level 2 to level 3 after the 10min interval', () {
      expect(resolveEscalation('unstarted:1', d('2026-07-05T10:10:00.000Z'), [entry('unstarted:1', 2, '2026-07-05T10:00:00.000Z')], [], escalationSettings), const EscalationResult(3));
    });

    test('caps at level 3 and repeats at the 10min interval', () {
      expect(resolveEscalation('unstarted:1', d('2026-07-05T10:10:00.000Z'), [entry('unstarted:1', 3, '2026-07-05T10:00:00.000Z')], [], escalationSettings), const EscalationResult(3));
    });

    test('resets to level 1 and fires immediately when an activity signal occurred after the last notification', () {
      final events = [makeActivityEvent(type: 'task_start', createdAt: '2026-07-05T10:02:00.000Z')];
      expect(resolveEscalation('unstarted:1', d('2026-07-05T10:05:00.000Z'), [entry('unstarted:1', 2, '2026-07-05T10:00:00.000Z')], events, escalationSettings), const EscalationResult(1));
    });

    test('ignores activity that happened before the last notification (does not reset)', () {
      final events = [makeActivityEvent(type: 'task_start', createdAt: '2026-07-05T09:00:00.000Z')];
      expect(resolveEscalation('unstarted:1', d('2026-07-05T10:05:00.000Z'), [entry('unstarted:1', 2, '2026-07-05T10:00:00.000Z')], events, escalationSettings), isNull);
    });

    test('only considers history for the matching rule_key', () {
      expect(resolveEscalation('unstarted:1', d('2026-07-05T10:00:00.000Z'), [entry('unstarted:2', 3, '2026-07-05T09:00:00.000Z')], [], escalationSettings), const EscalationResult(1));
    });

    test('uses the most recent entry when multiple history rows exist for the same rule_key', () {
      final n = [entry('unstarted:1', 1, '2026-07-05T09:00:00.000Z'), entry('unstarted:1', 2, '2026-07-05T10:00:00.000Z')];
      expect(resolveEscalation('unstarted:1', d('2026-07-05T10:10:00.000Z'), n, [], escalationSettings), const EscalationResult(3));
    });
  });
}
