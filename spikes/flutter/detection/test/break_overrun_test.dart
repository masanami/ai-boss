import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';

void main() {
  group('getActiveBreak', () {
    test('returns the last break_start when there is no matching break_end after it', () {
      final breakStart = makeActivityEvent(type: 'break_start', createdAt: '2026-07-05T10:00:00.000Z');
      expect(getActiveBreak([breakStart]), breakStart);
    });

    test('returns undefined when a break_end followed the last break_start', () {
      final breakStart = makeActivityEvent(type: 'break_start', createdAt: '2026-07-05T10:00:00.000Z');
      final breakEnd = makeActivityEvent(type: 'break_end', createdAt: '2026-07-05T10:10:00.000Z');
      expect(getActiveBreak([breakStart, breakEnd]), isNull);
    });

    test('returns undefined when there is no break_start at all', () => expect(getActiveBreak([]), isNull));

    test('uses the most recent break_start when there are multiple break cycles', () {
      final first = makeActivityEvent(type: 'break_start', createdAt: '2026-07-05T08:00:00.000Z');
      final firstEnd = makeActivityEvent(type: 'break_end', createdAt: '2026-07-05T08:10:00.000Z');
      final second = makeActivityEvent(type: 'break_start', createdAt: '2026-07-05T10:00:00.000Z');
      expect(getActiveBreak([first, firstEnd, second]), second);
    });

    test('ignores task_pause events and still returns the active break (#179 判断4: G-179-17 回帰)', () {
      final breakStart = makeActivityEvent(type: 'break_start', createdAt: '2026-07-05T10:00:00.000Z');
      final before = makeActivityEvent(type: 'task_pause', taskId: 1, createdAt: '2026-07-05T09:00:00.000Z');
      final after = makeActivityEvent(type: 'task_pause', taskId: 2, createdAt: '2026-07-05T10:05:00.000Z');
      expect(getActiveBreak([before, breakStart, after]), breakStart);
    });
  });

  group('isBreakOverrun', () {
    test('does not fire before the expected_minutes has elapsed', () {
      final b = makeActivityEvent(type: 'break_start', expectedMinutes: 15, createdAt: '2026-07-05T10:00:00.000Z');
      expect(isBreakOverrun(b, d('2026-07-05T10:14:59.000Z'), 15), isFalse);
    });

    test('fires once the expected_minutes has been exceeded', () {
      final b = makeActivityEvent(type: 'break_start', expectedMinutes: 15, createdAt: '2026-07-05T10:00:00.000Z');
      expect(isBreakOverrun(b, d('2026-07-05T10:15:01.000Z'), 15), isTrue);
    });

    test('falls back to the fallback minutes when expected_minutes is not set', () {
      final b = makeActivityEvent(type: 'break_start', expectedMinutes: null, createdAt: '2026-07-05T10:00:00.000Z');
      expect(isBreakOverrun(b, d('2026-07-05T10:15:01.000Z'), 15), isTrue);
    });
  });
}
