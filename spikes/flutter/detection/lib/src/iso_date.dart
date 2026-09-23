// server/src/lib/iso-date.ts の移植（TZ 非依存の暦日検証）。

final _dateOnlyPattern = RegExp(r'^\d{4}-\d{2}-\d{2}$');
final _isoDateTimePattern = RegExp(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))?$');

/// `year` 年 `month` 月（1 始まり）の日数。Dart の DateTime.utc は年 0〜99 を 1900 年代へ写さないため、TS 版の回避策は不要
int _daysInMonth(int year, int month) => DateTime.utc(year, month + 1, 0).day;

bool _isRealCalendarDate(int year, int month, int day) => month >= 1 && month <= 12 && day >= 1 && day <= _daysInMonth(year, month);

bool isValidIsoDateTime(String value) {
  final m = _isoDateTimePattern.firstMatch(value);
  if (m == null) return false;
  int n(int i, [int fallback = 0]) => m[i] == null ? fallback : int.parse(m[i]!);
  return _isRealCalendarDate(n(1), n(2), n(3)) && n(4) <= 23 && n(5) <= 59 && n(6) <= 59 && n(7) <= 23 && n(8) <= 59;
}

bool isValidIsoDateOrDateTime(String value) {
  if (_dateOnlyPattern.hasMatch(value)) {
    final p = value.split('-').map(int.parse).toList();
    return _isRealCalendarDate(p[0], p[1], p[2]);
  }
  return isValidIsoDateTime(value);
}
