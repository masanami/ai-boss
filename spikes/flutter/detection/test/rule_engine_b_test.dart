import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';
import 'rule_engine_helpers.dart';

// rule-engine.test.ts の describe("evaluateRules outside working hours (Issue #550 S2)")。

typedef Fired = ({DateTime at, FiringNotification firing});

void main() {
  group('evaluateRules outside working hours (Issue #550 S2)', () {
    const dayKey = '2026-09-14';
    const nextDayKey = '2026-09-15';
    DateTime day(int h, int min) => jsLocal(2026, 8, 14, h, min);
    DateTime nextDay(int h, int min) => jsLocal(2026, 8, 15, h, min);

    final lastCheckin = makeActivityEvent(type: 'checkin', createdAt: toIsoString(day(17, 0)));
    final unstartedTask = makeTask(id: 1, status: 'todo', createdAt: toIsoString(day(8, 0)));

    List<NotificationHistoryEntry> history(List<FiringNotification> firings, DateTime at) =>
        firings.map((f) => sent(f.ruleKey, f.escalationLevel, toIsoString(at))).toList();

    List<Fired> sweep(DateTime from, DateTime to, PartialInput input, [List<DateTime> activityAt = const []]) {
      final notifications = [...?input.notifications];
      final activityEvents = [...?input.activityEvents];
      final fired = <Fired>[];
      for (var t = from; t.isBefore(to); t = DateTime.fromMillisecondsSinceEpoch(t.millisecondsSinceEpoch + 60000)) {
        for (final a in activityAt) {
          if (a.millisecondsSinceEpoch == t.millisecondsSinceEpoch) {
            activityEvents.add(makeActivityEvent(type: 'checkin', createdAt: toIsoString(t)));
          }
        }
        final result = evaluateRules(input.merge(PartialInput(now: t, notifications: [...notifications], activityEvents: [...activityEvents])).toInput());
        notifications.addAll(history(result, t));
        fired.addAll(result.map((firing) => (at: t, firing: firing)));
      }
      return fired;
    }

    List<Fired> firingsOf(List<Fired> fired, String ruleType) => fired.where((f) => f.firing.ruleType == ruleType).toList();

    group('fires outside working hours', () {
      test('fires silence at level 1 at 20:00 with an empty notification history', () {
        expect(evaluateRules(baseInput(now: day(20, 0), activityEvents: [lastCheckin])), [fire('silence', 'silence:$dayKey', 1, null)]);
      });

      test('fires unstarted at level 1 at 20:00 with an empty notification history', () {
        expect(evaluateRules(baseInput(now: day(20, 0), tasks: [unstartedTask])), [fire('unstarted', 'unstarted:1:$dayKey', 1, 1)]);
      });

      test('fires avoidance at level 1 at 20:00 when the top task is avoided', () {
        final other = makeActivityEvent(type: 'task_update', taskId: 2, createdAt: toIsoString(day(19, 50)));
        expect(evaluateRules(baseInput(now: day(20, 0), tasks: [unstartedTask], activityEvents: [other])), [fire('avoidance', 'avoidance:1:$dayKey', 1, 1)]);
      });

      test('fires deadline_overdue at level 1 once per overdue task at 20:00', () {
        final first = makeTask(id: 11, status: 'in_progress', dueAt: '2026-09-12');
        final second = makeTask(id: 12, status: 'in_progress', dueAt: '2026-09-13');
        expect(evaluateRules(baseInput(now: day(20, 0), tasks: [first, second])), [
          fire('deadline_overdue', 'deadline_overdue:11:$dayKey', 1, 11),
          fire('deadline_overdue', 'deadline_overdue:12:$dayKey', 1, 12),
        ]);
      });

      test('fires break_overrun at level 1 at 20:00 when the declared break is overrun', () {
        final brk = makeActivityEvent(type: 'break_start', expectedMinutes: 15, createdAt: toIsoString(day(19, 30)));
        expect(evaluateRules(baseInput(now: day(20, 0), activityEvents: [brk])), [fire('break_overrun', 'break_overrun:$dayKey', 1, null)]);
      });
    });

    group('fires only once per outside-working-hours period (end of work → next start of work)', () {
      List<Fired> overnight() => sweep(day(18, 0), nextDay(9, 0), PartialInput(tasks: [unstartedTask], activityEvents: [lastCheckin]));

      test('fires silence exactly once across an 18:00 → 09:00 per-minute sweep (no extra firing at midnight)', () {
        expect(firingsOf(overnight(), 'silence'), [(at: day(18, 0), firing: fire('silence', 'silence:$dayKey', 1, null))]);
      });

      test('fires unstarted exactly once across the same sweep', () {
        expect(firingsOf(overnight(), 'unstarted').map((f) => (f.at, f.firing.ruleKey)).toList(), [(day(18, 0), 'unstarted:1:$dayKey')]);
      });

      test('does not fire again when the local date changes from 23:59 to 00:00 within the same period', () {
        final n = [sent('silence:$dayKey', 1, toIsoString(day(18, 0)))];
        for (final now in [day(23, 59), nextDay(0, 0), nextDay(8, 59)]) {
          expect(evaluateRules(baseInput(now: now, activityEvents: [lastCheckin], notifications: n)), isEmpty);
        }
      });

      test('keys a pre-start-of-work time to the period that began the previous day, and an after-end-of-work time to the same day', () {
        List<String> at(DateTime now) => evaluateRules(baseInput(now: now, activityEvents: [lastCheckin])).map((r) => r.ruleKey).toList();
        expect(at(day(18, 0)), ['silence:$dayKey']);
        expect(at(nextDay(8, 59)), ['silence:$dayKey']);
        expect(at(nextDay(0, 0)), ['silence:$dayKey']);
      });

      test('never escalates beyond level 1 outside working hours', () {
        final fired = overnight();
        expect(fired.length, greaterThan(0));
        expect(fired.every((f) => f.firing.escalationLevel == 1), isTrue);
      });

      test('does not re-fire the same rule_key on the same day after an activity signal is recorded', () {
        final fired = sweep(day(20, 0), day(23, 59), PartialInput(activityEvents: [lastCheckin]), [day(20, 30)]);
        expect(fired.map((f) => f.firing).toList(), [fire('silence', 'silence:$dayKey', 1, null)]);
      });

      test('stays at level 1 even after the escalation intervals elapse', () {
        final n = [sent('unstarted:1:$dayKey', 1, toIsoString(day(20, 0)))];
        for (final now in [day(20, 15), day(20, 30), day(23, 0)]) {
          expect(evaluateRules(baseInput(now: now, tasks: [unstartedTask], notifications: n)), isEmpty);
        }
      });
    });

    group('keeps the in-hours behavior unchanged', () {
      test('escalates L1 → L2 → L3 inside working hours via resolveEscalation', () {
        final fired = sweep(day(13, 0), day(13, 26), PartialInput(tasks: [unstartedTask]));
        expect(fired.map((f) => (f.at, f.firing.ruleKey, f.firing.escalationLevel)).toList(), [
          (day(13, 0), 'unstarted:1', 1),
          (day(13, 15), 'unstarted:1', 2),
          (day(13, 25), 'unstarted:1', 3),
        ]);
      });

      test('resets to level 1 on an activity signal inside working hours', () {
        final lunch = makeActivityEvent(type: 'checkin', createdAt: toIsoString(day(12, 0)));
        final fired = sweep(day(12, 45), day(13, 51), PartialInput(activityEvents: [lunch]), [day(13, 5)]);
        expect(fired.map((f) => (f.at, f.firing.ruleKey, f.firing.escalationLevel)).toList(), [
          (day(12, 45), 'silence', 1),
          (day(13, 0), 'silence', 2),
          (day(13, 50), 'silence', 1),
        ]);
      });

      test('escalates normally once working hours begin after an out-of-hours firing', () {
        final fired = sweep(nextDay(8, 0), nextDay(9, 26), PartialInput(tasks: [unstartedTask]));
        expect(fired.map((f) => (f.at, f.firing.ruleKey, f.firing.escalationLevel)).toList(), [
          (nextDay(8, 0), 'unstarted:1:$dayKey', 1),
          (nextDay(9, 0), 'unstarted:1', 1),
          (nextDay(9, 15), 'unstarted:1', 2),
          (nextDay(9, 25), 'unstarted:1', 3),
        ]);
      });
    });

    group('resets the once-per-period allowance in the next outside-working-hours period', () {
      test("fires silence outside working hours again in the next day's period after it fired", () {
        final n = [sent('silence:$dayKey', 1, toIsoString(day(20, 0)))];
        expect(evaluateRules(baseInput(now: nextDay(8, 59), activityEvents: [lastCheckin], notifications: n)), isEmpty);
        expect(evaluateRules(baseInput(now: nextDay(20, 0), activityEvents: [lastCheckin], notifications: n)), [fire('silence', 'silence:$nextDayKey', 1, null)]);
      });

      DateTime dayAfterNext(int h, int min) => jsLocal(2026, 8, 16, h, min);

      test('fires silence outside working hours once per period across two consecutive nights (per-minute sweep)', () {
        final fired = sweep(day(18, 0), dayAfterNext(9, 0), PartialInput(activityEvents: [lastCheckin], settings: settings.copyWith(dailyNotificationCap: 1000)));
        expect(firingsOf(fired, 'silence').where((f) => f.firing.ruleKey != 'silence').map((f) => (f.at, f.firing.ruleKey)).toList(), [
          (day(18, 0), 'silence:$dayKey'),
          (nextDay(18, 0), 'silence:$nextDayKey'),
        ]);
      });

      test("suppresses the second night's outside-hours firing under the default cap when the day in between used up the allowance (#562 S3 決定 14)", () {
        final silence = firingsOf(sweep(day(18, 0), dayAfterNext(9, 0), PartialInput(activityEvents: [lastCheckin])), 'silence');
        expect(silence.where((f) => f.firing.ruleKey != 'silence').map((f) => (f.at, f.firing.ruleKey)).toList(), [(day(18, 0), 'silence:$dayKey')]);
        expect(silence.where((f) => f.firing.ruleKey == 'silence').toList(), hasLength(5));
      });
    });

    group('derives the period start date for an evaluation before the start of work (Issue #553)', () {
      final hasSpringDstTransition = jsTimezoneOffset(jsLocal(2026, 2, 7, 12, 0)) != jsTimezoneOffset(jsLocal(2026, 2, 9, 12, 0));

      group('on the day after the spring DST transition (detects only under a DST timezone, e.g. npm run test:tz)', () {
        const dstDayKey = '2026-03-08';
        DateTime dstDay(int h, int min) => jsLocal(2026, 2, 8, h, min);
        DateTime dayAfterDst(int h, int min) => jsLocal(2026, 2, 9, h, min);
        final task = makeTask(id: 1, status: 'todo', createdAt: toIsoString(dstDay(8, 0)));

        test('keys the 00:30 evaluation to the previous local calendar day, not to 24 hours earlier', () {
          expect(evaluateRules(baseInput(now: dayAfterDst(0, 30), tasks: [task])), [fire('unstarted', 'unstarted:1:$dstDayKey', 1, 1)]);
        });

        test('does not fire again at 00:30 when it already fired the evening of the transition day', () {
          final n = [sent('unstarted:1:$dstDayKey', 1, toIsoString(dstDay(20, 0)))];
          expect(evaluateRules(baseInput(now: dayAfterDst(0, 30), tasks: [task], notifications: n)), isEmpty);
        });
      }, skip: hasSpringDstTransition ? false : 'no spring DST transition in this time zone (describe.runIf)');

      group('when work_start is malformed', () {
        const previousDayKey = '2026-09-13';
        DateTime previousDay(int h, int min) => jsLocal(2026, 8, 13, h, min);
        final malformedStart = settings.copyWith(workingHours: const WorkingHours(start: '9時', end: '18:00'));
        final task = makeTask(id: 1, status: 'todo', createdAt: toIsoString(previousDay(8, 0)));

        test('keys the 08:59 evaluation to the previous day, based on the default start of work 09:00', () {
          final spy = WarnSpy();
          expect(evaluateRules(baseInput(now: day(8, 59), tasks: [task], settings: malformedStart)), [fire('unstarted', 'unstarted:1:$previousDayKey', 1, 1)]);
          expect(spy.called, isTrue);
        });
      });

      group('when only work_end is malformed (Issue #555)', () {
        const previousDayKey = '2026-09-13';
        DateTime previousDay(int h, int min) => jsLocal(2026, 8, 13, h, min);
        final malformedEnd = settings.copyWith(workingHours: const WorkingHours(start: '08:00', end: 'banana'));
        final task = makeTask(id: 1, status: 'todo', createdAt: toIsoString(previousDay(8, 0)));

        setUp(WarnSpy.new);

        test('keys the 08:30 evaluation to the previous day, based on the default working hours as a whole', () {
          expect(evaluateRules(baseInput(now: day(8, 30), tasks: [task], settings: malformedEnd)), [fire('unstarted', 'unstarted:1:$previousDayKey', 1, 1)]);
        });

        test('does not fire again at 08:30 when it already fired at 20:00 the previous evening', () {
          final first = evaluateRules(baseInput(now: previousDay(20, 0), tasks: [task], settings: malformedEnd));
          final n = first.map((f) => sent(f.ruleKey, f.escalationLevel, toIsoString(previousDay(20, 0)))).toList();
          expect(first, [fire('unstarted', 'unstarted:1:$previousDayKey', 1, 1)]);
          expect(evaluateRules(baseInput(now: day(8, 30), tasks: [task], settings: malformedEnd, notifications: n)), isEmpty);
        });
      });
    });

    group('does not change the firing conditions themselves', () {
      test('does not fire silence outside working hours when there is no activity signal at all', () => expect(evaluateRules(baseInput(now: day(20, 0))), isEmpty));

      test('does not fire any gated rule outside working hours when no condition holds', () {
        final fresh = makeTask(id: 2, status: 'todo', createdAt: toIsoString(day(19, 30)));
        final recent = makeActivityEvent(type: 'checkin', createdAt: toIsoString(day(19, 50)));
        expect(evaluateRules(baseInput(now: day(20, 0), tasks: [fresh], activityEvents: [recent])), isEmpty);
      });
    });
  });
}
