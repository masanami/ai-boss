import 'package:aiboss_detection/aiboss_detection.dart';
import 'package:test/test.dart';

// detection-test-fixtures.ts の移植。TS の `Partial<Task>` の上書き（null を明示で渡せる）を
// 番兵値で表現する。

const _unset = Object();
T? _pick<T>(Object? v, T? fallback) => identical(v, _unset) ? fallback : v as T?;

var _nextTaskId = 1;

Task makeTask({
  int? id,
  String? title,
  Object? description = _unset,
  String? category,
  Object? priority = _unset,
  Object? dueAt = _unset,
  String? status,
  Object? bossComment = _unset,
  Object? estimatedMinutes = _unset,
  String? createdAt,
  String? updatedAt,
  Object? completedAt = _unset,
  bool? evidenceRequired,
  Object? committedStartAt = _unset,
  Object? committedAt = _unset,
}) {
  final taskId = id ?? _nextTaskId++;
  return Task(
    id: taskId,
    title: title ?? 'task-$taskId',
    description: _pick<String>(description, null),
    category: category ?? 'work',
    priority: _pick<String>(priority, null),
    dueAt: _pick<String>(dueAt, null),
    status: status ?? 'todo',
    bossComment: _pick<String>(bossComment, null),
    estimatedMinutes: _pick<num>(estimatedMinutes, null),
    createdAt: createdAt ?? '2026-07-05T00:00:00.000Z',
    updatedAt: updatedAt ?? '2026-07-05T00:00:00.000Z',
    completedAt: _pick<String>(completedAt, null),
    evidenceRequired: evidenceRequired ?? false,
    committedStartAt: _pick<String>(committedStartAt, null),
    committedAt: _pick<String>(committedAt, null),
  );
}

var _nextActivityEventId = 1;

ActivityEvent makeActivityEvent({int? id, String? type, Object? taskId = _unset, Object? note = _unset, Object? expectedMinutes = _unset, String? createdAt}) {
  return ActivityEvent(
    id: id ?? _nextActivityEventId++,
    type: type ?? 'checkin',
    taskId: _pick<int>(taskId, null),
    note: _pick<String>(note, null),
    expectedMinutes: _pick<num>(expectedMinutes, null),
    createdAt: createdAt ?? '2026-07-05T00:00:00.000Z',
  );
}

/// `new Date(isoString)`（テスト内の固定時刻。解釈可能な値のみ）
DateTime d(String iso) => jsParse(iso)!;

/// vi.spyOn(console, "warn") 相当: warn を差し替え、呼ばれた回数を返す
class WarnSpy {
  WarnSpy() {
    _original = warn;
    warn = (m) => calls.add(m);
    addTearDown(restore);
  }
  late final void Function(String) _original;
  final calls = <String>[];
  bool get called => calls.isNotEmpty;
  void restore() => warn = _original;
}
