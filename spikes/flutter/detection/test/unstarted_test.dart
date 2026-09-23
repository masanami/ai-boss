import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';

final unstartedSettings = defaultDetectionSettings.unstarted;

void main() {
  group('computeUnstartedThresholdMinutes', () {
    test('uses the fallback (60min) when estimated_minutes is not set', () => expect(computeUnstartedThresholdMinutes(makeTask(estimatedMinutes: null), unstartedSettings), 60));
    test('scales estimated_minutes at a 1.0 factor within the clamp range', () => expect(computeUnstartedThresholdMinutes(makeTask(estimatedMinutes: 45), unstartedSettings), 45));
    test('clamps small estimated_minutes up to the 15min floor', () => expect(computeUnstartedThresholdMinutes(makeTask(estimatedMinutes: 5), unstartedSettings), 15));
    test('clamps large estimated_minutes down to the 120min ceiling', () => expect(computeUnstartedThresholdMinutes(makeTask(estimatedMinutes: 300), unstartedSettings), 120));
  });

  group('isTopTaskUnstarted', () {
    Task task(String status) => makeTask(status: status, estimatedMinutes: 30, createdAt: '2026-07-05T09:00:00.000Z');
    test('does not fire just before the threshold', () => expect(isTopTaskUnstarted(task('todo'), d('2026-07-05T09:29:59.000Z'), unstartedSettings), isFalse));
    test('fires exactly at the threshold', () => expect(isTopTaskUnstarted(task('todo'), d('2026-07-05T09:30:00.000Z'), unstartedSettings), isTrue));
    test('does not fire when the task is already in_progress', () => expect(isTopTaskUnstarted(task('in_progress'), d('2026-07-05T10:00:00.000Z'), unstartedSettings), isFalse));
  });
}
