import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';

void main() {
  group('isMeetingDue', () {
    test('fires when the meeting time has passed and no session of that type started today', () => expect(isMeetingDue(jsLocal(2026, 6, 5, 9, 0, 0), '09:00', 'morning', []), isTrue));
    test('does not fire before the meeting time', () => expect(isMeetingDue(jsLocal(2026, 6, 5, 8, 59, 0), '09:00', 'morning', []), isFalse));
    test('does not fire once the session type has already started today', () => expect(isMeetingDue(jsLocal(2026, 6, 5, 9, 30, 0), '09:00', 'morning', ['morning']), isFalse));
    test('evaluates the evening meeting independently of the morning session', () => expect(isMeetingDue(jsLocal(2026, 6, 5, 18, 30, 0), '18:00', 'evening', ['morning']), isTrue));

    test('does not fire (and warns) when the configured meeting time is malformed', () {
      final spy = WarnSpy();
      expect(isMeetingDue(jsLocal(2026, 6, 5, 9, 30, 0), 'banana', 'morning', []), isFalse);
      expect(spy.called, isTrue);
    });
  });

  group('buildMeetingRuleKey', () {
    test('builds a rule_key that includes the session type, the local date, and the effective meeting time', () {
      expect(buildMeetingRuleKey('morning', jsLocal(2026, 6, 5, 9, 30, 0), '09:00'), 'morning_meeting:2026-07-05@09:00');
    });

    test('differs per day so the rule resets daily', () {
      expect(buildMeetingRuleKey('morning', jsLocal(2026, 6, 5, 9, 30, 0), '09:00'), isNot(buildMeetingRuleKey('morning', jsLocal(2026, 6, 6, 9, 30, 0), '09:00')));
    });

    test('reflects the given effective meeting time in the HH:mm portion of the key', () {
      expect(buildMeetingRuleKey('evening', jsLocal(2026, 6, 5, 21, 0, 0), '21:00'), 'evening_meeting:2026-07-05@21:00');
    });

    test('differs when only the effective meeting time differs (same day, same session type)', () {
      final now = jsLocal(2026, 6, 5, 21, 0, 0);
      expect(buildMeetingRuleKey('evening', now, '18:00'), isNot(buildMeetingRuleKey('evening', now, '21:00')));
    });

    test('uses the local calendar date, not the UTC date, near local midnight', () {
      expect(buildMeetingRuleKey('morning', jsLocal(2026, 6, 5, 23, 30, 0), '09:00'), 'morning_meeting:2026-07-05@09:00');
      expect(buildMeetingRuleKey('morning', jsLocal(2026, 6, 5, 0, 30, 0), '09:00'), 'morning_meeting:2026-07-05@09:00');
    });
  });
}
