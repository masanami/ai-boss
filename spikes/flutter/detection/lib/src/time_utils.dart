import 'dart:io' show stderr;
import 'dart:math' as math;
import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;
import 'detection_types.dart';
import 'js_date.dart';

// server/src/detection/time-utils.ts の移植。

/// console.warn の代わり。テストで差し替えて呼ばれたことを検証する（vi.spyOn(console, "warn") 相当）。
void Function(String message) warn = (message) => stderr.writeln(message);

/// 値を [min, max] の範囲に収める
num clamp(num value, num min, num max) => math.min(math.max(value, min), max);

/// later - earlier の経過時間を分単位で返す
double diffInMinutes(DateTime later, DateTime earlier) =>
    (later.millisecondsSinceEpoch - earlier.millisecondsSinceEpoch) / (60 * 1000);

/// JS 版は `new Date(iso)` を受けるため、Invalid Date を NaN として扱う版も用意する
double diffInMinutesFromIso(DateTime later, String earlierIso) =>
    (later.millisecondsSinceEpoch - jsTime(earlierIso)) / (60 * 1000);

final _timeStringPattern = RegExp(r'^\d{1,2}:\d{2}$');

/// "HH:mm" 形式の文字列を、真夜中からの経過分に変換する。不正な形式は警告ログを出して null。
int? timeStringToMinutes(String time) {
  if (!_timeStringPattern.hasMatch(time)) {
    warn('invalid time string (expected "HH:mm"): "$time"');
    return null;
  }
  final parts = time.split(':').map(int.parse).toList();
  final hours = parts[0];
  final minutes = parts[1];
  if (hours > 23 || minutes > 59) {
    warn('invalid time string (out of range): "$time"');
    return null;
  }
  return hours * 60 + minutes;
}

/// 現在時刻（ローカル）が勤務時間帯 [start, end) に含まれるか。
bool isWithinWorkingHours(DateTime now, WorkingHours workingHours) {
  final local = now.toLocal();
  final nowMinutes = local.hour * 60 + local.minute;
  final startMinutes = timeStringToMinutes(workingHours.start);
  final endMinutes = timeStringToMinutes(workingHours.end);
  if (startMinutes == null || endMinutes == null) {
    return isWithinWorkingHours(now, defaultDetectionSettings.workingHours);
  }
  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

var _tzInitialized = false;

/// 日付を YYYY-MM-DD 形式で返す。`timeZone` 省略時はローカル暦日、IANA 名を渡すとその TZ での暦日。
/// （TS 版の Intl.DateTimeFormat の代わりに package:timezone を使う）
String toDateKey(DateTime date, [String? timeZone]) {
  String two(int n) => n.toString().padLeft(2, '0');
  if (timeZone == null) {
    final l = date.toLocal();
    return '${l.year.toString().padLeft(4, '0')}-${two(l.month)}-${two(l.day)}';
  }
  if (!_tzInitialized) {
    tzdata.initializeTimeZones();
    _tzInitialized = true;
  }
  // Intl は "UTC" を受理するが package:timezone の DB には無い（"Etc/UTC" のみ）
  final location = timeZone == 'UTC' ? tz.UTC : tz.getLocation(timeZone);
  final t = tz.TZDateTime.from(date, location);
  return '${t.year.toString().padLeft(4, '0')}-${two(t.month)}-${two(t.day)}';
}

/// ローカル日時を `YYYY-MM-DD HH:mm` 形式で返す
String toLocalDateTimeKey(DateTime date) {
  final l = date.toLocal();
  return '${toDateKey(l)} ${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}';
}

final _dateKeyPattern = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$');

/// `YYYY-MM-DD` をローカル日付として解釈する。形式不正・実在しない暦日は null。
DateTime? parseDateKey(String dateKey) {
  final match = _dateKeyPattern.firstMatch(dateKey);
  if (match == null) return null;
  final date = DateTime(int.parse(match[1]!), int.parse(match[2]!), int.parse(match[3]!));
  if (toDateKey(date) != dateKey) return null;
  return date;
}

/// ローカルタイムゾーンの UTC オフセットを `±HH:MM` 形式で返す
String toLocalOffset(DateTime date) {
  final offsetMinutes = -jsTimezoneOffset(date);
  final sign = offsetMinutes < 0 ? '-' : '+';
  final absolute = offsetMinutes.abs();
  return '$sign${(absolute ~/ 60).toString().padLeft(2, '0')}:${(absolute % 60).toString().padLeft(2, '0')}';
}

/// items の中から、getTimestamp が返す ISO8601 文字列が最も新しい要素を返す（入力は破壊しない）。
/// JS の Array.prototype.sort と同じく安定ソートの先頭を返す（同時刻なら先に現れた要素）。
T? latestByTimestamp<T>(List<T> items, String Function(T item) getTimestamp) {
  if (items.isEmpty) return null;
  final indexed = [for (var i = 0; i < items.length; i++) (i, items[i])];
  indexed.sort((a, b) {
    final diff = jsTime(getTimestamp(b.$2)) - jsTime(getTimestamp(a.$2));
    if (diff.isNaN || diff == 0) return a.$1.compareTo(b.$1);
    return diff < 0 ? -1 : 1;
  });
  return indexed.first.$2;
}
