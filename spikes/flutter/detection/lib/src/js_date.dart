// JS の Date と Dart の DateTime の意味差を吸収する翻訳用ヘルパ（元の TS には無い層）。
//
// - `new Date("YYYY-MM-DD")`（日付のみ）は JS では **UTC 0 時**、Dart の DateTime.parse ではローカル 0 時
// - `new Date("...T..")`（オフセット無し日時）は両者ともローカル
// - JS は解釈不能な文字列で Invalid Date（getTime() が NaN）を返し、Dart は例外を投げる
// - `toISOString()` は常に UTC・ミリ秒 3 桁・末尾 Z
// - `new Date(y, m, d, ...)` の月は 0 始まり、Dart の DateTime は 1 始まり（範囲外の正規化は両者同じ）

final _isoDateOnly = RegExp(r'^\d{4}-\d{2}-\d{2}$');
final _isoLike = RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$');

/// `new Date(isoString)` 相当。解釈できなければ null（JS の Invalid Date）。
/// 検知エンジンが扱うのは ISO 8601 形式のみ（非 ISO 文字列は `isValidIsoDateOrDateTime` で先に弾かれる）。
DateTime? jsParse(String value) {
  if (_isoDateOnly.hasMatch(value)) {
    final p = value.split('-').map(int.parse).toList();
    final utc = DateTime.utc(p[0], p[1], p[2]);
    // 範囲外（2026-13-01 等）は JS では Invalid Date
    if (utc.year != p[0] || utc.month != p[1] || utc.day != p[2]) return null;
    return utc.toLocal();
  }
  if (!_isoLike.hasMatch(value)) return null;
  final parsed = DateTime.tryParse(value);
  return parsed?.toLocal();
}

/// `new Date(isoString).getTime()` 相当（Invalid Date は NaN）。
double jsTime(String value) {
  final d = jsParse(value);
  return d == null ? double.nan : d.millisecondsSinceEpoch.toDouble();
}

/// `new Date(year, monthIndex, day, h, m, s, ms)` 相当（月は 0 始まり・ローカル）。
DateTime jsLocal(int year, int monthIndex, [int day = 1, int hour = 0, int minute = 0, int second = 0, int ms = 0]) =>
    DateTime(year, monthIndex + 1, day, hour, minute, second, ms);

/// `Date.UTC(...)` から作った Date 相当（月は 0 始まり）。
DateTime jsUtc(int year, int monthIndex, [int day = 1, int hour = 0, int minute = 0]) =>
    DateTime.utc(year, monthIndex + 1, day, hour, minute).toLocal();

/// `date.toISOString()` 相当。
String toIsoString(DateTime date) {
  final u = date.toUtc();
  String two(int n) => n.toString().padLeft(2, '0');
  final year = u.year >= 0 && u.year <= 9999 ? u.year.toString().padLeft(4, '0') : (u.year < 0 ? '-' : '+') + u.year.abs().toString().padLeft(6, '0');
  return '$year-${two(u.month)}-${two(u.day)}T${two(u.hour)}:${two(u.minute)}:${two(u.second)}.${u.millisecond.toString().padLeft(3, '0')}Z';
}

/// `date.getTimezoneOffset()` 相当（UTC からの遅れを分で。符号は Dart の timeZoneOffset と逆）。
int jsTimezoneOffset(DateTime date) => -date.toLocal().timeZoneOffset.inMinutes;
