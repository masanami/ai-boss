import 'iso_date.dart';
import 'js_date.dart';
import 'time_utils.dart';

// server/src/tasks/due-at.ts ＋ activity/local-day.ts（startOfNextLocalDayIso）の移植。

final _dateOnlyPattern = RegExp(r'^\d{4}-\d{2}-\d{2}$');

/// `new Date(y, m, d + 1).toISOString()`（翌ローカル暦日の 00:00）
String startOfNextLocalDayIso(DateTime date) {
  final l = date.toLocal();
  return toIsoString(DateTime(l.year, l.month, l.day + 1));
}

String startOfLocalDayIso([DateTime? date]) {
  final l = (date ?? DateTime.now()).toLocal();
  return toIsoString(DateTime(l.year, l.month, l.day));
}

DateTime? _resolveDueAtLocalDay(String dueAt) {
  if (_dateOnlyPattern.hasMatch(dueAt)) return parseDateKey(dueAt);
  final instant = jsParse(dueAt);
  if (instant == null) return null;
  return parseDateKey(toDateKey(instant));
}

/// 締切が切れる瞬時（epoch ミリ秒）。締切の暦日 D の翌ローカル暦日 D+1 の 00:00（ADR 0010 決定 2）。
int? toDueAtInstant(String? dueAt) {
  if (dueAt == null || !isValidIsoDateOrDateTime(dueAt)) return null;
  final localDay = _resolveDueAtLocalDay(dueAt);
  if (localDay == null) return null;
  return DateTime.parse(startOfNextLocalDayIso(localDay)).millisecondsSinceEpoch;
}

String? normalizeDueAtToDateKey(String? dueAt) {
  if (dueAt == null || !isValidIsoDateOrDateTime(dueAt)) return null;
  final localDay = _resolveDueAtLocalDay(dueAt);
  if (localDay == null) return null;
  return toDateKey(localDay);
}
