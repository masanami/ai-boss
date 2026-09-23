import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';

void main() {
  group('hasRecentActivityOnOtherTasks', () {
    final now = d('2026-07-05T10:00:00.000Z');
    bool check(String type, int? taskId, String createdAt) =>
        hasRecentActivityOnOtherTasks(makeTask(id: 1), now, [makeActivityEvent(type: type, taskId: taskId, createdAt: createdAt)], 30);

    test('returns true when another task had a task_start within the window', () => expect(check('task_start', 2, '2026-07-05T09:45:00.000Z'), isTrue));
    test('returns true when another task had a task_update within the window', () => expect(check('task_update', 2, '2026-07-05T09:45:00.000Z'), isTrue));
    test('returns false when the activity is older than the window', () => expect(check('task_start', 2, '2026-07-05T09:29:00.000Z'), isFalse));
    test('returns false when the activity is on the top-priority task itself', () => expect(check('task_start', 1, '2026-07-05T09:45:00.000Z'), isFalse));
    test('returns false for activity types unrelated to task work (e.g. checkin)', () => expect(check('checkin', 2, '2026-07-05T09:45:00.000Z'), isFalse));
    test('returns false when the event timestamp is in the future (clock skew)', () => expect(check('task_start', 2, '2026-07-05T10:05:00.000Z'), isFalse));
    test('returns false when task_id is null', () => expect(check('task_start', null, '2026-07-05T09:45:00.000Z'), isFalse));
  });
}
