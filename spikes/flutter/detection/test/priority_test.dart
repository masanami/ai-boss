import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';

final earlierDue = toDateKey(jsLocal(2026, 6, 6));
final laterDue = toDateKey(jsLocal(2026, 6, 10));
const invalidDueAts = ['0', 'not-a-date-at-all', '2026-13-01', '2026-02-30', '12/31/2026', ''];

void main() {
  group('pickTopPriorityTask', () {
    test('picks the higher priority task over a lower priority one', () {
      final low = makeTask(id: 1, priority: 'low');
      final high = makeTask(id: 2, priority: 'high');
      expect(pickTopPriorityTask([low, high]), high);
    });

    test('ranks a null priority below low priority', () {
      final none = makeTask(id: 1, priority: null);
      final low = makeTask(id: 2, priority: 'low');
      expect(pickTopPriorityTask([none, low]), low);
    });

    test('breaks a priority tie by earlier due_at', () {
      final later = makeTask(id: 1, priority: 'high', dueAt: laterDue);
      final earlier = makeTask(id: 2, priority: 'high', dueAt: earlierDue);
      expect(pickTopPriorityTask([later, earlier]), earlier);
    });

    test('treats a null due_at as last among a due_at tie-break', () {
      final withDue = makeTask(id: 1, priority: 'high', dueAt: laterDue);
      final noDue = makeTask(id: 2, priority: 'high', dueAt: null);
      expect(pickTopPriorityTask([noDue, withDue]), withDue);
    });

    test('breaks a full tie by ascending id', () {
      final higherId = makeTask(id: 5, priority: 'high');
      final lowerId = makeTask(id: 2, priority: 'high');
      expect(pickTopPriorityTask([higherId, lowerId]), lowerId);
    });

    test('excludes done and dropped tasks from the candidates', () {
      final done = makeTask(id: 1, priority: 'high', status: 'done');
      final dropped = makeTask(id: 2, priority: 'high', status: 'dropped');
      final todo = makeTask(id: 3, priority: 'low', status: 'todo');
      expect(pickTopPriorityTask([done, dropped, todo]), todo);
    });

    test('returns undefined when there are no eligible tasks', () => expect(pickTopPriorityTask([makeTask(id: 1, status: 'done')]), isNull));

    test('excludes a paused task from the candidates (#179 判断4: G-179-7)', () {
      final paused = makeTask(id: 1, priority: 'high', status: 'paused');
      final todo = makeTask(id: 2, priority: 'low', status: 'todo');
      expect(pickTopPriorityTask([paused, todo]), todo);
    });

    test('ranks a legacy time-of-day due_at by its local calendar day', () {
      final legacyEarlier = makeTask(id: 1, priority: 'high', dueAt: toIsoString(jsLocal(2026, 6, 6, 18)));
      final later = makeTask(id: 2, priority: 'high', dueAt: laterDue);
      expect(pickTopPriorityTask([later, legacyEarlier]), legacyEarlier);
    });

    for (final invalidDueAt in invalidDueAts) {
      test('ranks an unparseable due_at ("$invalidDueAt") behind a real due_at regardless of input order (AC-9)', () {
        final invalid = makeTask(id: 1, priority: 'high', dueAt: invalidDueAt);
        final withDue = makeTask(id: 2, priority: 'high', dueAt: laterDue);
        expect(pickTopPriorityTask([invalid, withDue]), withDue);
        expect(pickTopPriorityTask([withDue, invalid]), withDue);
      });
    }

    for (final invalidDueAt in invalidDueAts) {
      test('ranks an unparseable due_at ("$invalidDueAt") level with a null due_at, falling back to id order (AC-9)', () {
        final invalidLowerId = makeTask(id: 1, priority: 'high', dueAt: invalidDueAt);
        final nullHigherId = makeTask(id: 2, priority: 'high', dueAt: null);
        expect(pickTopPriorityTask([invalidLowerId, nullHigherId]), invalidLowerId);
        expect(pickTopPriorityTask([nullHigherId, invalidLowerId]), invalidLowerId);

        final nullLowerId = makeTask(id: 1, priority: 'high', dueAt: null);
        final invalidHigherId = makeTask(id: 2, priority: 'high', dueAt: invalidDueAt);
        expect(pickTopPriorityTask([nullLowerId, invalidHigherId]), nullLowerId);
        expect(pickTopPriorityTask([invalidHigherId, nullLowerId]), nullLowerId);
      });
    }
  });
}
