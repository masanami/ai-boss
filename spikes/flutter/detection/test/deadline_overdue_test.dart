import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';

final dueDay = jsLocal(2026, 6, 5);
final dueDateKey = toDateKey(dueDay);
final atBoundary = jsLocal(2026, 6, 6);
final justAfterBoundary = jsLocal(2026, 6, 6, 0, 0, 0, 1);
final duringDueDay = jsLocal(2026, 6, 5, 17);

void main() {
  group('findOverdueTasks', () {
    test('returns a todo task once the day after its due date has begun', () {
      final overdue = makeTask(status: 'todo', dueAt: dueDateKey);
      expect(findOverdueTasks([overdue], justAfterBoundary), [overdue]);
    });

    test('does not include a task exactly at the start of the day after its due date (not yet overdue)', () {
      expect(findOverdueTasks([makeTask(status: 'todo', dueAt: dueDateKey)], atBoundary), isEmpty);
    });

    test('does not include a task during its own due date (the deadline covers the whole calendar day)', () {
      expect(findOverdueTasks([makeTask(status: 'todo', dueAt: dueDateKey)], duringDueDay), isEmpty);
    });

    test('does not include a task with no due_at', () {
      expect(findOverdueTasks([makeTask(status: 'todo', dueAt: null)], justAfterBoundary), isEmpty);
    });

    test('does not include done or dropped tasks even if overdue', () {
      final done = makeTask(status: 'done', dueAt: dueDateKey);
      final dropped = makeTask(status: 'dropped', dueAt: dueDateKey);
      expect(findOverdueTasks([done, dropped], justAfterBoundary), isEmpty);
    });

    test('includes an overdue in_progress task', () {
      final t = makeTask(status: 'in_progress', dueAt: dueDateKey);
      expect(findOverdueTasks([t], justAfterBoundary), [t]);
    });

    test('returns every overdue task, not just the top-priority one', () {
      final first = makeTask(id: 1, status: 'todo', dueAt: toDateKey(jsLocal(2026, 6, 4)));
      final second = makeTask(id: 2, status: 'todo', dueAt: dueDateKey);
      expect(findOverdueTasks([first, second], justAfterBoundary), [first, second]);
    });

    test('includes an overdue paused task (#179 判断4: G-179-8)', () {
      final paused = makeTask(status: 'paused', dueAt: dueDateKey);
      expect(findOverdueTasks([paused], justAfterBoundary), [paused]);
    });

    test('interprets a legacy time-of-day due_at as its local calendar day', () {
      final legacy = makeTask(status: 'todo', dueAt: toIsoString(jsLocal(2026, 6, 5, 18)));
      expect(findOverdueTasks([legacy], duringDueDay), isEmpty);
      expect(findOverdueTasks([legacy], jsLocal(2026, 6, 6, 0, 0, 0, 1)), [legacy]);
    });

    for (final dueAt in ['0', 'not-a-date-at-all', '2026-13-01', '2026-02-30', '12/31/2026', '']) {
      test('does not treat an unparseable due_at ("$dueAt") as overdue (AC-8)', () {
        expect(findOverdueTasks([makeTask(status: 'todo', dueAt: dueAt)], justAfterBoundary), isEmpty);
      });
    }
  });
}
