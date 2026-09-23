import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';
import 'rule_engine_helpers.dart';

// rule-engine.test.ts の describe("evaluateRules") 部分（1〜795 行目相当）。

void main() {
  group('evaluateRules', () {
    test('fires an unstarted notification for a top-priority task past its threshold', () {
      final task = makeTask(id: 1, status: 'todo', priority: 'high', estimatedMinutes: 30, createdAt: '2026-07-05T11:00:00');
      expect(evaluateRules(baseInput(tasks: [task])), [fire('unstarted', 'unstarted:1', 1, 1)]);
    });

    test('does not fire the unstarted rule before the threshold has elapsed', () {
      final task = makeTask(id: 1, status: 'todo', priority: 'high', estimatedMinutes: 30, createdAt: '2026-07-05T11:45:00');
      expect(evaluateRules(baseInput(tasks: [task])), isEmpty);
    });

    test('prefers avoidance over unstarted when there is recent activity on another task', () {
      final topTask = makeTask(id: 1, status: 'todo', priority: 'high', estimatedMinutes: 30, createdAt: '2026-07-05T11:00:00');
      final other = [makeActivityEvent(type: 'task_update', taskId: 2, createdAt: '2026-07-05T11:50:00')];
      expect(evaluateRules(baseInput(tasks: [topTask], activityEvents: other)), [fire('avoidance', 'avoidance:1', 1, 1)]);
    });

    test('suppresses all rules except break_overrun while on break', () {
      final overdueTask = makeTask(id: 1, status: 'todo', dueAt: '2026-07-04');
      final activeBreak = makeActivityEvent(type: 'break_start', expectedMinutes: 15, createdAt: '2026-07-05T11:00:00');
      expect(evaluateRules(baseInput(tasks: [overdueTask], activityEvents: [activeBreak])), [fire('break_overrun', 'break_overrun', 1, null)]);
    });

    test('keeps suppressing every rule except break_overrun while on break outside working hours (#550)', () {
      final overdueTask = makeTask(id: 1, status: 'todo', dueAt: '2026-07-04');
      final activeBreak = makeActivityEvent(type: 'break_start', expectedMinutes: 15, createdAt: toIsoString(jsLocal(2026, 6, 5, 19, 0)));
      expect(
        evaluateRules(baseInput(now: jsLocal(2026, 6, 5, 20, 0), tasks: [overdueTask], activityEvents: [activeBreak])),
        [fire('break_overrun', 'break_overrun:2026-07-05', 1, null)],
      );
    });

    test('does not fire break_overrun when only a paused task exists and no break is active (#179 判断4: G-179-17)', () {
      final paused = makeTask(id: 1, status: 'paused');
      final pauseEvent = makeActivityEvent(type: 'task_pause', taskId: 1, createdAt: '2026-07-05T09:00:00');
      final result = evaluateRules(baseInput(now: d('2026-07-05T10:00:00'), tasks: [paused], activityEvents: [pauseEvent]));
      expect(ruleTypes(result), isNot(contains('break_overrun')));
    });

    group('first deadline_overdue firing for a calendar-day due date (AC-16)', () {
      final overdueTask = makeTask(id: 1, status: 'todo', dueAt: '2026-07-05');
      List<FiringNotification> deadlineFirings(DateTime now) =>
          evaluateRules(baseInput(now: now, tasks: [overdueTask])).where((r) => r.ruleType == 'deadline_overdue').toList();

      test('does not fire during the due date itself, inside working hours', () => expect(deadlineFirings(jsLocal(2026, 6, 5, 17)), isEmpty));

      test('fires once at level 1 with a period-scoped rule_key after the deadline lapses but before working hours begin (#550)', () {
        expect(deadlineFirings(jsLocal(2026, 6, 6, 8)), [fire('deadline_overdue', 'deadline_overdue:1:2026-07-05', 1, 1)]);
      });

      test('fires at the start of business on the day after the due date', () {
        expect(deadlineFirings(jsLocal(2026, 6, 6, 9)), [fire('deadline_overdue', 'deadline_overdue:1', 1, 1)]);
      });
    });

    test('fires deadline_overdue notifications for every overdue task independently', () {
      final first = makeTask(id: 1, status: 'todo', dueAt: '2026-07-03');
      final second = makeTask(id: 2, status: 'todo', dueAt: '2026-07-04');
      final result = evaluateRules(baseInput(tasks: [first, second]));
      expect(result, contains(fire('deadline_overdue', 'deadline_overdue:1', 1, 1)));
      expect(result, contains(fire('deadline_overdue', 'deadline_overdue:2', 1, 2)));
    });

    test('does not re-fire a rule_key before its escalation interval has elapsed (duplicate suppression)', () {
      final task = makeTask(id: 1, status: 'todo', priority: 'high', estimatedMinutes: 30, createdAt: '2026-07-05T10:00:00');
      expect(evaluateRules(baseInput(tasks: [task], notifications: [sent('unstarted:1', 1, '2026-07-05T11:59:00')])), isEmpty);
    });

    test('escalates to level 2 once the level-1 interval has elapsed', () {
      final task = makeTask(id: 1, status: 'todo', priority: 'high', estimatedMinutes: 30, createdAt: '2026-07-05T10:00:00');
      expect(
        evaluateRules(baseInput(tasks: [task], notifications: [sent('unstarted:1', 1, '2026-07-05T11:45:00')])),
        [fire('unstarted', 'unstarted:1', 2, 1)],
      );
    });

    test('fires the morning meeting rule even outside working hours and even while on break', () {
      final activeBreak = makeActivityEvent(type: 'break_start', createdAt: '2026-07-05T19:50:00');
      final result = evaluateRules(baseInput(now: d('2026-07-05T20:00:00'), activityEvents: [activeBreak], todaysSessionTypes: []));
      expect(result, contains(fire('morning_meeting', 'morning_meeting:2026-07-05@09:00', 1, null)));
    });

    test('returns no notifications when nothing warrants one', () => expect(evaluateRules(baseInput()), isEmpty));

    group('commitment_missed (Issue #524)', () {
      DateTime day(int h, int min) => jsLocal(2026, 8, 14, h, min);
      DateTime nextDay(int h, int min) => jsLocal(2026, 8, 15, h, min);
      String iso(DateTime t) => toIsoString(t);
      Task committed(int id, DateTime startAt, DateTime at, {String status = 'todo'}) =>
          makeTask(id: id, status: status, committedStartAt: iso(startAt), committedAt: iso(at));

      test('fires commitment_missed exactly at the committed time (0-minute grace), not one minute before', () {
        final task = committed(1, day(14, 0), day(9, 30));
        expect(evaluateRules(baseInput(now: day(14, 0), tasks: [task])), [fire('commitment_missed', buildCommitmentMissedRuleKey(task), 1, 1)]);
        expect(evaluateRules(baseInput(now: day(13, 59), tasks: [task])), isEmpty);
      });

      for (final status in ['in_progress', 'paused', 'done', 'dropped']) {
        test('does not fire commitment_missed for a $status task even past the committed time', () {
          final task = committed(1, day(14, 0), day(9, 30), status: status);
          expect(ruleTypes(evaluateRules(baseInput(now: day(14, 30), tasks: [task]))), isNot(contains('commitment_missed')));
        });
      }

      test("fires commitment_missed for a non-top-priority task's commitment", () {
        final taskA = makeTask(id: 1, priority: 'high', status: 'in_progress', committedStartAt: null, committedAt: null);
        final taskB = makeTask(id: 2, priority: 'low', status: 'todo', committedStartAt: iso(day(14, 0)), committedAt: iso(day(9, 0)));
        expect(evaluateRules(baseInput(now: day(14, 30), tasks: [taskA, taskB])), contains(fire('commitment_missed', buildCommitmentMissedRuleKey(taskB), 1, 2)));
      });

      Task topWithCommitment() => makeTask(id: 1, status: 'todo', createdAt: iso(day(9, 0)), estimatedMinutes: null, committedStartAt: iso(day(14, 0)), committedAt: iso(day(9, 30)));

      test('does not fire unstarted for a top-priority task with a commitment, even before the commitment time', () {
        expect(ruleTypes(evaluateRules(baseInput(now: day(13, 0), tasks: [topWithCommitment()]))), isNot(contains('unstarted')));
      });

      test('does not fire avoidance for a top-priority task with a commitment, even with recent activity on other tasks', () {
        final other = [makeActivityEvent(type: 'task_start', taskId: 999, createdAt: iso(day(12, 50)))];
        expect(ruleTypes(evaluateRules(baseInput(now: day(13, 0), tasks: [topWithCommitment()], activityEvents: other))), isNot(contains('avoidance')));
      });

      test("fires only commitment_missed (not unstarted) once the top-priority task's commitment time has passed", () {
        final task = topWithCommitment();
        expect(evaluateRules(baseInput(now: day(14, 30), tasks: [task])), [fire('commitment_missed', buildCommitmentMissedRuleKey(task), 1, 1)]);
      });

      test('does not fall back to evaluating unstarted for the next-priority task when the top-priority task has a commitment', () {
        final taskA = makeTask(id: 1, priority: 'high', status: 'todo', committedStartAt: iso(day(20, 0)), committedAt: iso(day(9, 0)));
        final taskB = makeTask(id: 2, priority: 'low', status: 'todo', committedStartAt: null, committedAt: null, createdAt: iso(day(9, 0)), estimatedMinutes: null);
        expect(ruleTypes(evaluateRules(baseInput(now: day(13, 0), tasks: [taskA, taskB]))), isNot(contains('unstarted')));
      });

      test('still fires unstarted at exactly the threshold for a top-priority task without a commitment (unaffected)', () {
        final task = makeTask(id: 1, status: 'todo', createdAt: iso(day(9, 0)), estimatedMinutes: null, committedStartAt: null, committedAt: null);
        expect(ruleTypes(evaluateRules(baseInput(now: day(10, 0), tasks: [task]))), contains('unstarted'));
        expect(ruleTypes(evaluateRules(baseInput(now: day(9, 59), tasks: [task]))), isNot(contains('unstarted')));
      });

      test('returns a commitment_missed ruleKey in the form commitment_missed:{taskId}:{committed_start_at}:{committed_at}', () {
        final startAt = iso(day(14, 0));
        final at = iso(day(9, 30));
        final task = makeTask(id: 7, status: 'todo', committedStartAt: startAt, committedAt: at);
        expect(evaluateRules(baseInput(now: day(14, 0), tasks: [task])), [fire('commitment_missed', 'commitment_missed:7:$startAt:$at', 1, 7)]);
      });

      test('does not carry over notification history from a changed commitment time (new ruleKey => L1)', () {
        final firstTask = committed(42, day(14, 0), day(9, 30));
        final firstResult = evaluateRules(baseInput(now: day(14, 0), tasks: [firstTask]));
        expect(firstResult, hasLength(1));
        final notifications = [sent(firstResult[0].ruleKey, 1, iso(day(14, 0)))];
        final secondTask = committed(42, day(14, 10), day(14, 5));
        expect(evaluateRules(baseInput(now: day(14, 20), tasks: [secondTask], notifications: notifications)),
            [fire('commitment_missed', buildCommitmentMissedRuleKey(secondTask), 1, 42)]);
      });

      test('escalates to L2 at +15 minutes within working hours, not yet at +14', () {
        final task = committed(1, day(14, 0), day(9, 30));
        final ruleKey = buildCommitmentMissedRuleKey(task);
        final n = [sent(ruleKey, 1, iso(day(14, 0)))];
        expect(evaluateRules(baseInput(now: day(14, 14), tasks: [task], notifications: n)), isEmpty);
        expect(evaluateRules(baseInput(now: day(14, 15), tasks: [task], notifications: n)), [fire('commitment_missed', ruleKey, 2, 1)]);
      });

      test('resets to L1 within working hours when an activity signal occurs after the last notification', () {
        final task = committed(1, day(14, 0), day(9, 30));
        final ruleKey = buildCommitmentMissedRuleKey(task);
        final events = [makeActivityEvent(type: 'chat_message', createdAt: iso(day(14, 5)))];
        expect(evaluateRules(baseInput(now: day(14, 6), tasks: [task], notifications: [sent(ruleKey, 1, iso(day(14, 0)))], activityEvents: events)),
            [fire('commitment_missed', ruleKey, 1, 1)]);
      });

      test('fires L1 outside working hours when the ruleKey has no notification history yet', () {
        final task = committed(1, day(20, 0), day(9, 0));
        expect(evaluateRules(baseInput(now: day(20, 0), tasks: [task])), [fire('commitment_missed', buildCommitmentMissedRuleKey(task), 1, 1)]);
      });

      test('does not re-fire outside working hours once the ruleKey already has notification history, even without activity', () {
        final task = committed(1, day(20, 0), day(9, 0));
        final n = [sent(buildCommitmentMissedRuleKey(task), 1, iso(day(20, 0)))];
        expect(evaluateRules(baseInput(now: day(20, 15), tasks: [task], notifications: n)), isEmpty);
      });

      test('does not re-fire outside working hours even when an activity signal follows the notification', () {
        final task = committed(1, day(20, 0), day(9, 0));
        final n = [sent(buildCommitmentMissedRuleKey(task), 1, iso(day(20, 0)))];
        final events = [makeActivityEvent(type: 'chat_message', createdAt: iso(day(20, 5)))];
        expect(evaluateRules(baseInput(now: day(20, 6), tasks: [task], notifications: n, activityEvents: events)), isEmpty);
      });

      test('does not re-fire once working hours end for a commitment already notified inside working hours', () {
        final task = committed(1, day(17, 0), day(9, 0));
        final n = [sent(buildCommitmentMissedRuleKey(task), 1, iso(day(17, 0)))];
        expect(evaluateRules(baseInput(now: day(18, 0), tasks: [task], notifications: n)), isEmpty);
      });

      test('escalates to L2 once the next working-hours window begins the next day, not before it', () {
        final task = committed(1, day(20, 0), day(9, 0));
        final ruleKey = buildCommitmentMissedRuleKey(task);
        final n = [sent(ruleKey, 1, iso(day(20, 0)))];
        expect(evaluateRules(baseInput(now: nextDay(8, 59), tasks: [task], notifications: n)), isEmpty);
        expect(evaluateRules(baseInput(now: nextDay(9, 0), tasks: [task], notifications: n)), [fire('commitment_missed', ruleKey, 2, 1)]);
      });

      test('fires L1 outside working hours the next calendar day when there is still no notification history (no calendar-day cutoff)', () {
        final task = committed(1, day(20, 0), day(9, 0));
        expect(evaluateRules(baseInput(now: nextDay(2, 0), tasks: [task])), [fire('commitment_missed', buildCommitmentMissedRuleKey(task), 1, 1)]);
      });

      test('fires L1 outside working hours when the commitment was moved (20:00 -> 21:00), even with history for the old commitment', () {
        final firstTask = committed(5, day(20, 0), day(19, 0));
        final firstResult = evaluateRules(baseInput(now: day(20, 0), tasks: [firstTask]));
        expect(firstResult, hasLength(1));
        final n = [sent(firstResult[0].ruleKey, 1, iso(day(20, 0)))];
        final secondTask = committed(5, day(21, 0), day(20, 5));
        expect(evaluateRules(baseInput(now: day(21, 0), tasks: [secondTask], notifications: n)), [fire('commitment_missed', buildCommitmentMissedRuleKey(secondTask), 1, 5)]);
      });

      test('fires L1 outside working hours when the commitment was moved back to its original time (20:00 -> 21:00 -> 20:00), even with history for the first instance', () {
        final firstTask = committed(6, day(20, 0), day(19, 0));
        final firstResult = evaluateRules(baseInput(now: day(20, 0), tasks: [firstTask]));
        expect(firstResult, hasLength(1));
        final n = [sent(firstResult[0].ruleKey, 1, iso(day(20, 0)))];
        final secondTask = committed(6, day(20, 0), day(20, 10));
        expect(evaluateRules(baseInput(now: day(20, 10), tasks: [secondTask], notifications: n)), [fire('commitment_missed', buildCommitmentMissedRuleKey(secondTask), 1, 6)]);
      });

      test('fires commitment_missed inside working hours while on a declared break', () {
        final task = committed(1, day(14, 0), day(9, 0));
        final brk = [makeActivityEvent(type: 'break_start', createdAt: iso(day(13, 55)))];
        expect(evaluateRules(baseInput(now: day(14, 0), tasks: [task], activityEvents: brk)), [fire('commitment_missed', buildCommitmentMissedRuleKey(task), 1, 1)]);
      });

      test('fires commitment_missed outside working hours while on a declared break', () {
        final task = committed(1, day(20, 0), day(9, 0));
        final brk = [makeActivityEvent(type: 'break_start', createdAt: iso(day(19, 55)))];
        expect(evaluateRules(baseInput(now: day(20, 0), tasks: [task], activityEvents: brk)), [fire('commitment_missed', buildCommitmentMissedRuleKey(task), 1, 1)]);
      });

      test('does not re-fire outside working hours while on a declared break once notification history exists (still the 1-time rule)', () {
        final task = committed(1, day(20, 0), day(9, 0));
        final n = [sent(buildCommitmentMissedRuleKey(task), 1, iso(day(20, 0)))];
        final brk = [makeActivityEvent(type: 'break_start', expectedMinutes: 30, createdAt: iso(day(19, 55)))];
        expect(evaluateRules(baseInput(now: day(20, 15), tasks: [task], notifications: n, activityEvents: brk)), isEmpty);
      });

      test('fires commitment_missed alongside the other rules outside working hours, each once at level 1 (#550)', () {
        final taskA = committed(1, day(20, 0), day(9, 0));
        final taskB = makeTask(id: 2, status: 'todo', committedStartAt: null, committedAt: null, dueAt: '2026-09-13');
        expect(evaluateRules(baseInput(now: day(20, 0), tasks: [taskA, taskB])), [
          fire('unstarted', 'unstarted:2:2026-09-14', 1, 2),
          fire('deadline_overdue', 'deadline_overdue:2:2026-09-14', 1, 2),
          fire('commitment_missed', buildCommitmentMissedRuleKey(taskA), 1, 1),
        ]);
      });
    });
  });
}
