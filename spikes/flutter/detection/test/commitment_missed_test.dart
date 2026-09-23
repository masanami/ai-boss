import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';

final committedAtInstant = jsLocal(2026, 8, 14, 14, 0);
final committedStartAt = toIsoString(committedAtInstant);

void main() {
  group('hasMissedCommitment', () {
    test('is true for a todo task exactly at its committed start time (grace period is 0 minutes)', () {
      final task = makeTask(status: 'todo', committedStartAt: committedStartAt, committedAt: '2026-07-05T00:00:00.000Z');
      expect(hasMissedCommitment(task, jsLocal(2026, 8, 14, 14, 0)), isTrue);
    });

    test('is false one minute before the committed start time', () {
      final task = makeTask(status: 'todo', committedStartAt: committedStartAt, committedAt: '2026-07-05T00:00:00.000Z');
      expect(hasMissedCommitment(task, jsLocal(2026, 8, 14, 13, 59)), isFalse);
    });

    for (final status in ['in_progress', 'paused', 'done', 'dropped']) {
      test('is false for a $status task even past its committed start time', () {
        final task = makeTask(status: status, committedStartAt: committedStartAt, committedAt: '2026-07-05T00:00:00.000Z');
        expect(hasMissedCommitment(task, jsLocal(2026, 8, 14, 14, 30)), isFalse);
      });
    }

    test('is false for a todo task with no commitment', () {
      final task = makeTask(status: 'todo', committedStartAt: null, committedAt: null);
      expect(hasMissedCommitment(task, jsLocal(2026, 8, 14, 14, 30)), isFalse);
    });
  });

  group('findMissedCommitmentTasks', () {
    test('returns every task with a missed commitment regardless of priority (evaluates all, like findOverdueTasks)', () {
      final highNoCommitment = makeTask(id: 1, priority: 'high', status: 'in_progress', committedStartAt: null, committedAt: null);
      final lowMissed = makeTask(id: 2, priority: 'low', status: 'todo', committedStartAt: committedStartAt, committedAt: '2026-07-05T00:00:00.000Z');
      expect(findMissedCommitmentTasks([highNoCommitment, lowMissed], jsLocal(2026, 8, 14, 14, 30)), [lowMissed]);
    });
  });

  group('buildCommitmentMissedRuleKey', () {
    test('includes taskId, committed_start_at, and committed_at (in that order)', () {
      final task = makeTask(id: 7, committedStartAt: toIsoString(jsLocal(2026, 8, 14, 14, 0)), committedAt: toIsoString(jsLocal(2026, 8, 14, 9, 30)));
      expect(buildCommitmentMissedRuleKey(task), 'commitment_missed:7:${toIsoString(jsLocal(2026, 8, 14, 14, 0))}:${toIsoString(jsLocal(2026, 8, 14, 9, 30))}');
    });

    test('produces a different rule_key when only committed_at differs (same committed_start_at)', () {
      final first = makeTask(id: 7, committedStartAt: committedStartAt, committedAt: '2026-09-14T00:00:00.000Z');
      final second = makeTask(id: 7, committedStartAt: committedStartAt, committedAt: '2026-09-14T05:00:00.000Z');
      expect(buildCommitmentMissedRuleKey(first), isNot(buildCommitmentMissedRuleKey(second)));
    });
  });

  group('hasNoHistoryForRuleKey', () {
    test('is true when no notification history entry matches the rule_key', () => expect(hasNoHistoryForRuleKey('commitment_missed:1:a:b', []), isTrue));

    test('is false when a notification history entry matches the rule_key', () {
      const n = [NotificationHistoryEntry(ruleKey: 'commitment_missed:1:a:b', escalationLevel: 1, sentAt: '2026-09-14T11:00:00.000Z')];
      expect(hasNoHistoryForRuleKey('commitment_missed:1:a:b', n), isFalse);
    });

    test('is true when history entries exist but for a different rule_key', () {
      const n = [NotificationHistoryEntry(ruleKey: 'commitment_missed:1:a:different', escalationLevel: 1, sentAt: '2026-09-14T11:00:00.000Z')];
      expect(hasNoHistoryForRuleKey('commitment_missed:1:a:b', n), isTrue);
    });
  });
}
