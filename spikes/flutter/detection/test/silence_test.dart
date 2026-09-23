import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';

final silenceSettings = defaultDetectionSettings.silence;
ActivityEvent start(int taskId, String at) => makeActivityEvent(type: 'task_start', taskId: taskId, createdAt: at);

void main() {
  group('computeSilenceThresholdMinutes', () {
    test('falls back to 45min when there is no in-progress task with estimated_minutes', () => expect(computeSilenceThresholdMinutes([], [], silenceSettings), 45));

    test('scales the threshold from the estimated_minutes of the last task_start target', () {
      final task = makeTask(id: 1, status: 'in_progress', estimatedMinutes: 60);
      expect(computeSilenceThresholdMinutes([start(1, '2026-07-05T09:00:00.000Z')], [task], silenceSettings), 45);
    });

    test('clamps the scaled threshold down to the 90min ceiling', () {
      final task = makeTask(id: 1, status: 'in_progress', estimatedMinutes: 300);
      expect(computeSilenceThresholdMinutes([start(1, '2026-07-05T09:00:00.000Z')], [task], silenceSettings), 90);
    });

    test('clamps the scaled threshold up to the 20min floor', () {
      final task = makeTask(id: 1, status: 'in_progress', estimatedMinutes: 10);
      expect(computeSilenceThresholdMinutes([start(1, '2026-07-05T09:00:00.000Z')], [task], silenceSettings), 20);
    });

    test('uses the most recent task_start when there have been several', () {
      final oldTask = makeTask(id: 1, status: 'in_progress', estimatedMinutes: 10);
      final newTask = makeTask(id: 2, status: 'in_progress', estimatedMinutes: 60);
      final events = [start(1, '2026-07-05T08:00:00.000Z'), start(2, '2026-07-05T09:00:00.000Z')];
      expect(computeSilenceThresholdMinutes(events, [oldTask, newTask], silenceSettings), 45);
    });

    test('falls back to 45min when the last task_start target has since been paused (#179 判断4: G-179-9)', () {
      final task = makeTask(id: 1, status: 'paused', estimatedMinutes: 200);
      expect(computeSilenceThresholdMinutes([start(1, '2026-07-05T09:00:00.000Z')], [task], silenceSettings), 45);
    });
  });

  group('isSilent', () {
    test('returns false when there is no activity history at all (no baseline)', () => expect(isSilent(d('2026-07-05T12:00:00.000Z'), [], [], silenceSettings), isFalse));

    test('does not fire just before the threshold', () {
      final events = [makeActivityEvent(type: 'checkin', createdAt: '2026-07-05T09:00:00.000Z')];
      expect(isSilent(d('2026-07-05T09:44:59.000Z'), events, [], silenceSettings), isFalse);
    });

    test('fires exactly at the threshold', () {
      final events = [makeActivityEvent(type: 'checkin', createdAt: '2026-07-05T09:00:00.000Z')];
      expect(isSilent(d('2026-07-05T09:45:00.000Z'), events, [], silenceSettings), isTrue);
    });
  });
}
