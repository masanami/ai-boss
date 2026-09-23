import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';
import 'rule_engine_helpers.dart';

// rule-engine.test.ts の describe("evaluateRules daily notification cap (Issue #562 S3)")。

void main() {
  group('evaluateRules daily notification cap (Issue #562 S3)', () {
    const prevDayKey = '2026-09-13';
    const dayKey = '2026-09-14';
    DateTime prevDay(int h, int min) => jsLocal(2026, 8, 13, h, min);
    DateTime day(int h, int min) => jsLocal(2026, 8, 14, h, min);
    DateTime nextDay(int h, int min) => jsLocal(2026, 8, 15, h, min);
    final now = day(12, 0);

    final unstartedTask = makeTask(id: 3, status: 'todo', createdAt: toIsoString(prevDay(7, 0)));
    const levels = [1, 2, 3, 3, 3, 3, 3, 3, 3, 3];

    List<NotificationHistoryEntry> sentAt(String ruleKey, List<DateTime> sentAts) =>
        [for (var i = 0; i < sentAts.length; i++) sent(ruleKey, i < levels.length ? levels[i] : 3, toIsoString(sentAts[i]))];

    List<NotificationHistoryEntry> inHoursHistory(String ruleKey, int count, [DateTime Function(int, int)? onDay]) =>
        sentAt(ruleKey, List.generate(count, (i) => (onDay ?? day)(10, 45 + i * 10)));

    DetectionSettings withCap(int cap) => defaultDetectionSettings.copyWith(dailyNotificationCap: cap);

    List<String> ruleKeysAt(PartialInput input) =>
        evaluateRules(PartialInput(now: now).merge(input).toInput()).map((f) => f.ruleKey).toList();

    group('the cap boundary', () {
      test('fires unstarted:3 in working hours when 4 notifications were sent today (the 5th still fires)', () {
        expect(ruleKeysAt(PartialInput(tasks: [unstartedTask], notifications: inHoursHistory('unstarted:3', 4))), contains('unstarted:3'));
      });

      test('does not fire unstarted:3 in working hours when 5 notifications were sent today (the 6th does not fire)', () {
        expect(ruleKeysAt(PartialInput(tasks: [unstartedTask], notifications: inHoursHistory('unstarted:3', 5))), isNot(contains('unstarted:3')));
      });

      test('does not fire unstarted:3 with 1 notification today when the cap is set to 1', () {
        expect(ruleKeysAt(PartialInput(tasks: [unstartedTask], notifications: inHoursHistory('unstarted:3', 1), settings: withCap(1))), isNot(contains('unstarted:3')));
      });

      test('fires unstarted:3 with 5 notifications today when the cap is set to 10 (the default 5 is not hard-coded)', () {
        expect(ruleKeysAt(PartialInput(tasks: [unstartedTask], notifications: inHoursHistory('unstarted:3', 5), settings: withCap(10))), contains('unstarted:3'));
      });

      test('does not give the allowance back when an activity signal follows the latest notification (the L1 reset does not reset the cap)', () {
        final input = PartialInput(
          tasks: [unstartedTask],
          notifications: inHoursHistory('unstarted:3', 5),
          activityEvents: [makeActivityEvent(type: 'checkin', createdAt: toIsoString(day(11, 40)))],
        );
        expect(ruleKeysAt(input), isNot(contains('unstarted:3')));
        expect(evaluateRules(PartialInput(now: now).merge(input).merge(PartialInput(settings: withCap(10))).toInput()), contains(fire('unstarted', 'unstarted:3', 1, 3)));
      });

      test('counts each notification once regardless of its escalation level (L1, L2, L3, L3, L3)', () {
        final n = inHoursHistory('unstarted:3', 5);
        expect(n.map((e) => e.escalationLevel).toList(), [1, 2, 3, 3, 3]);
        expect(ruleKeysAt(PartialInput(tasks: [unstartedTask], notifications: n)), isNot(contains('unstarted:3')));
      });
    });

    group('counts by the base rule_key', () {
      test("counts an outside-hours period key sent before today's start of work (unstarted:3:{D-1} at D 02:00) toward the in-hours unstarted:3 allowance", () {
        final n = [...inHoursHistory('unstarted:3', 4), ...sentAt('unstarted:3:$prevDayKey', [day(2, 0)])];
        expect(ruleKeysAt(PartialInput(tasks: [unstartedTask], notifications: n)), isNot(contains('unstarted:3')));
      });

      test('does not count unstarted:30 (or unstarted:30:{D}) toward unstarted:3 (no prefix matching)', () {
        final n = [...inHoursHistory('unstarted:30', 5), ...sentAt('unstarted:30:$dayKey', [day(2, 0)])];
        expect(ruleKeysAt(PartialInput(tasks: [unstartedTask], notifications: n)), contains('unstarted:3'));
      });

      test('does not count avoidance:3 toward unstarted:3 (a different rule type has its own allowance)', () {
        expect(ruleKeysAt(PartialInput(tasks: [unstartedTask], notifications: inHoursHistory('avoidance:3', 5))), contains('unstarted:3'));
      });

      test('keeps a separate deadline_overdue allowance per task', () {
        final capped = makeTask(id: 11, status: 'in_progress', dueAt: '2026-09-12');
        final other = makeTask(id: 12, status: 'in_progress', dueAt: '2026-09-12');
        final keys = ruleKeysAt(PartialInput(tasks: [capped, other], notifications: inHoursHistory('deadline_overdue:11', 5)));
        expect(keys, isNot(contains('deadline_overdue:11')));
        expect(keys, contains('deadline_overdue:12'));
      });
    });

    group('resets at local midnight (TZ-independent)', () {
      test("fires unstarted:3 at D+1 09:00 when all 5 notifications were sent at D 23:59 (yesterday's allowance does not carry over)", () {
        final n = sentAt('unstarted:3', List.filled(5, day(23, 59)));
        expect(ruleKeysAt(PartialInput(now: nextDay(9, 0), tasks: [unstartedTask], notifications: n)), contains('unstarted:3'));
      });

      test('does not fire unstarted:3 at D+1 09:00 when all 5 notifications were sent at D+1 00:00 (00:00 belongs to the new day)', () {
        final n = sentAt('unstarted:3', List.filled(5, nextDay(0, 0)));
        expect(ruleKeysAt(PartialInput(now: nextDay(9, 0), tasks: [unstartedTask], notifications: n)), isNot(contains('unstarted:3')));
      });
    });

    group("outside working hours (counted against the period's start date)", () {
      final fiveInHoursOnD = inHoursHistory('unstarted:3', 5);

      test("does not fire unstarted:3:{D} at D 18:00 when 5 notifications were sent in D's working hours", () {
        expect(ruleKeysAt(PartialInput(now: day(18, 0), tasks: [unstartedTask], notifications: fiveInHoursOnD)), isNot(contains('unstarted:3:$dayKey')));
      });

      test('does not fire unstarted:3:{D} at D+1 00:00 either (the same period is still counted against D; no midnight firing)', () {
        expect(ruleKeysAt(PartialInput(now: nextDay(0, 0), tasks: [unstartedTask], notifications: fiveInHoursOnD)), isEmpty);
      });

      test("fires unstarted:3 at D+1 09:00 in working hours (the next day's allowance is free)", () {
        expect(ruleKeysAt(PartialInput(now: nextDay(9, 0), tasks: [unstartedTask], notifications: fiveInHoursOnD)), contains('unstarted:3'));
      });

      test("fires unstarted:3:{D} at D 18:00 when only 3 notifications were sent in D's working hours (below the cap, once per period as before)", () {
        expect(ruleKeysAt(PartialInput(now: day(18, 0), tasks: [unstartedTask], notifications: inHoursHistory('unstarted:3', 3))), contains('unstarted:3:$dayKey'));
      });

      test("does not fire unstarted:3:{D-1} at D 02:00 when D-1's working hours had 5 notifications and D has none (counted by the period's start date, not now's date)", () {
        expect(ruleKeysAt(PartialInput(now: day(2, 0), tasks: [unstartedTask], notifications: inHoursHistory('unstarted:3', 5, prevDay))), isNot(contains('unstarted:3:$prevDayKey')));
      });
    });

    group('target rules', () {
      final cases = [
        (rule: 'silence', ruleKey: 'silence', input: PartialInput(activityEvents: [makeActivityEvent(type: 'checkin', createdAt: toIsoString(day(10, 0)))])),
        (rule: 'break_overrun', ruleKey: 'break_overrun', input: PartialInput(activityEvents: [makeActivityEvent(type: 'break_start', expectedMinutes: 15, createdAt: toIsoString(day(10, 0)))])),
        (rule: 'avoidance', ruleKey: 'avoidance:3', input: PartialInput(tasks: [unstartedTask], activityEvents: [makeActivityEvent(type: 'task_update', taskId: 2, createdAt: toIsoString(day(11, 50)))])),
        (rule: 'deadline_overdue', ruleKey: 'deadline_overdue:3', input: PartialInput(tasks: [makeTask(id: 3, status: 'in_progress', dueAt: '2026-09-12')])),
      ];
      for (final c in cases) {
        test('does not fire ${c.rule} in working hours with 5 notifications today, and fires with 4', () {
          expect(ruleKeysAt(c.input.merge(PartialInput(notifications: inHoursHistory(c.ruleKey, 4)))), contains(c.ruleKey));
          expect(ruleKeysAt(c.input.merge(PartialInput(notifications: inHoursHistory(c.ruleKey, 5)))), isNot(contains(c.ruleKey)));
        });
      }

      test("does not fire commitment_missed in working hours with 5 notifications today for that commitment's base key, and fires with 4", () {
        final task = makeTask(id: 3, status: 'todo', committedStartAt: toIsoString(day(10, 0)), committedAt: toIsoString(day(9, 0)));
        final ruleKey = buildCommitmentMissedRuleKey(task);
        expect(ruleKeysAt(PartialInput(tasks: [task], notifications: inHoursHistory(ruleKey, 4))), contains(ruleKey));
        expect(ruleKeysAt(PartialInput(tasks: [task], notifications: inHoursHistory(ruleKey, 5))), isNot(contains(ruleKey)));
      });

      test('still fires morning_meeting with 5 notifications today for its rule_key (meetings are not capped)', () {
        const ruleKey = 'morning_meeting:$dayKey@09:00';
        expect(ruleKeysAt(PartialInput(todaysSessionTypes: ['evening'], notifications: inHoursHistory(ruleKey, 5))), contains(ruleKey));
      });

      test('still fires evening_meeting with 5 notifications today for its rule_key (meetings are not capped)', () {
        const ruleKey = 'evening_meeting:$dayKey@18:00';
        final n = sentAt(ruleKey, [day(18, 5), day(18, 15), day(18, 25), day(18, 35), day(18, 45)]);
        expect(ruleKeysAt(PartialInput(now: day(19, 0), todaysSessionTypes: ['morning'], notifications: n)), contains(ruleKey));
      });
    });
  });
}
