import 'dart:io';
import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';
import 'fixtures.dart';

/// `Intl.DateTimeFormat().resolvedOptions().timeZone` 相当。Dart 標準には IANA 名を返す API が無いため、
/// TZ 環境変数 → /etc/localtime のリンク先から求める（翻訳で追加が要った部分）。
String systemTimeZoneName() {
  final env = Platform.environment['TZ'];
  if (env != null && env.isNotEmpty) return env;
  final target = Link('/etc/localtime').targetSync();
  return target.split('zoneinfo/').last;
}

void main() {
  group('clamp', () {
    test('returns the value unchanged when within range', () => expect(clamp(50, 15, 120), 50));
    test('clamps to the minimum when below range', () => expect(clamp(5, 15, 120), 15));
    test('clamps to the maximum when above range', () => expect(clamp(200, 15, 120), 120));
  });

  group('diffInMinutes', () {
    test('returns the number of minutes elapsed between two dates', () {
      final earlier = d('2026-07-05T09:00:00');
      final later = d('2026-07-05T09:30:00');
      expect(diffInMinutes(later, earlier), 30);
    });
  });

  group('timeStringToMinutes', () {
    test('converts an HH:mm string to minutes since midnight', () => expect(timeStringToMinutes('09:30'), 570));

    for (final input in ['', '9', 'ab:cd', '09:5', 'banana']) {
      test('returns null and warns for a malformed time string ("$input")', () {
        final spy = WarnSpy();
        expect(timeStringToMinutes(input), isNull);
        expect(spy.called, isTrue);
      });
    }

    for (final input in ['24:00', '09:60']) {
      test('returns null and warns for an out-of-range time string ("$input")', () {
        final spy = WarnSpy();
        expect(timeStringToMinutes(input), isNull);
        expect(spy.called, isTrue);
      });
    }
  });

  group('isWithinWorkingHours', () {
    const workingHours = WorkingHours(start: '09:00', end: '18:00');

    test('returns true when now is inside the window', () => expect(isWithinWorkingHours(d('2026-07-05T12:00:00'), workingHours), isTrue));
    test('returns true at the exact start boundary', () => expect(isWithinWorkingHours(d('2026-07-05T09:00:00'), workingHours), isTrue));
    test('returns false at the exact end boundary (end is exclusive)', () => expect(isWithinWorkingHours(d('2026-07-05T18:00:00'), workingHours), isFalse));
    test('returns false before the start', () => expect(isWithinWorkingHours(d('2026-07-05T08:59:00'), workingHours), isFalse));
    test('returns false after the end', () => expect(isWithinWorkingHours(d('2026-07-05T18:01:00'), workingHours), isFalse));

    test('falls back to the default working hours (09:00-18:00) when the setting is malformed', () {
      final spy = WarnSpy();
      const malformed = WorkingHours(start: 'banana', end: '18:00');
      expect(isWithinWorkingHours(d('2026-07-05T12:00:00'), malformed), isTrue);
      expect(isWithinWorkingHours(d('2026-07-05T08:00:00'), malformed), isFalse);
      expect(spy.called, isTrue);
    });
  });

  group('toDateKey', () {
    test('formats a local date as YYYY-MM-DD', () => expect(toDateKey(jsLocal(2026, 6, 5, 23, 30)), '2026-07-05'));
    test('zero-pads single-digit months and days', () => expect(toDateKey(jsLocal(2026, 0, 2, 0, 0)), '2026-01-02'));

    test('zero-pads years below 1000 to four digits and round-trips through parseDateKey', () {
      // JS: new Date(2026, 0, 2).setFullYear(100)
      final date = DateTime(100, 1, 2);
      expect(toDateKey(date), '0100-01-02');
      expect(parseDateKey(toDateKey(date)), isNotNull);
    });

    group('with an explicit timeZone', () {
      test("uses the given IANA time zone's calendar day, not the process TZ", () {
        final instant = jsUtc(2026, 6, 5, 23, 30);
        expect(toDateKey(instant, 'Asia/Tokyo'), '2026-07-06');
        expect(toDateKey(instant, 'UTC'), '2026-07-05');
      });

      test('rolls back to the previous calendar day west of UTC', () {
        final instant = jsUtc(2026, 6, 6, 0, 30);
        expect(toDateKey(instant, 'America/New_York'), '2026-07-05');
        expect(toDateKey(instant, 'UTC'), '2026-07-06');
      });

      test('zero-pads single-digit months and days for a non-UTC time zone', () {
        expect(toDateKey(jsUtc(2026, 0, 1, 20, 30), 'Asia/Tokyo'), '2026-01-02');
      });

      test("agrees with the no-argument result when given the process's own resolved time zone", () {
        final date = jsLocal(2026, 6, 5, 23, 30);
        expect(toDateKey(date, systemTimeZoneName()), toDateKey(date));
      });
    });
  });

  group('toLocalDateTimeKey', () {
    test('formats a local date/time as YYYY-MM-DD HH:mm', () => expect(toLocalDateTimeKey(jsLocal(2026, 8, 14, 20, 0)), '2026-09-14 20:00'));
    test('zero-pads single-digit hours and minutes', () => expect(toLocalDateTimeKey(jsLocal(2026, 8, 14, 9, 5)), '2026-09-14 09:05'));
  });

  group('toLocalOffset', () {
    test('formats the local UTC offset as ±HH:MM', () {
      expect(toLocalOffset(jsLocal(2026, 8, 5, 14, 32)), matches(RegExp(r'^[+-]\d{2}:\d{2}$')));
    });

    test('returns an offset whose sign and magnitude match getTimezoneOffset()', () {
      final date = jsLocal(2026, 8, 5, 14, 32);
      final expectedMinutes = -jsTimezoneOffset(date);
      final m = RegExp(r'^([+-])(\d{2}):(\d{2})$').firstMatch(toLocalOffset(date))!;
      final actualMinutes = (m[1] == '-' ? -1 : 1) * (int.parse(m[2]!) * 60 + int.parse(m[3]!));
      // Dart の int には -0 が無いため TS 版の normalizeZero は不要
      expect(actualMinutes, expectedMinutes);
    });
  });
}
