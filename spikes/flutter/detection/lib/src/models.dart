// server/src/tasks/task.ts / activity/activity-event.ts / sessions/session.ts の移植（検知エンジンが使う分）。
// TS の構造的等価（vitest の toEqual）に合わせて値の等価を実装する。

const taskStatuses = ['todo', 'in_progress', 'paused', 'done', 'dropped'];
const taskPriorities = ['high', 'medium', 'low'];

class Task {
  const Task({
    required this.id,
    required this.title,
    this.description,
    this.category = 'work',
    this.priority,
    this.dueAt,
    this.status = 'todo',
    this.bossComment,
    this.estimatedMinutes,
    required this.createdAt,
    required this.updatedAt,
    this.completedAt,
    this.evidenceRequired = false,
    this.committedStartAt,
    this.committedAt,
  });

  final int id;
  final String title;
  final String? description;
  final String category;
  final String? priority; // 'high' | 'medium' | 'low' | null
  final String? dueAt;
  final String status; // 'todo' | 'in_progress' | 'paused' | 'done' | 'dropped'
  final String? bossComment;
  final num? estimatedMinutes;
  final String createdAt;
  final String updatedAt;
  final String? completedAt;
  final bool evidenceRequired;
  final String? committedStartAt;
  final String? committedAt;

  List<Object?> get _props => [id, title, description, category, priority, dueAt, status, bossComment, estimatedMinutes, createdAt, updatedAt, completedAt, evidenceRequired, committedStartAt, committedAt];

  @override
  bool operator ==(Object other) => other is Task && _listEquals(_props, other._props);
  @override
  int get hashCode => Object.hashAll(_props);
  @override
  String toString() => 'Task($id, $status, due=$dueAt)';
}

const activityEventTypes = ['task_start', 'break_start', 'break_end', 'checkin', 'chat_message', 'task_update', 'task_pause'];

class ActivityEvent {
  const ActivityEvent({
    required this.id,
    required this.type,
    this.taskId,
    this.note,
    this.expectedMinutes,
    required this.createdAt,
  });

  final int id;
  final String type;
  final int? taskId;
  final String? note;
  final num? expectedMinutes;
  final String createdAt;

  List<Object?> get _props => [id, type, taskId, note, expectedMinutes, createdAt];

  @override
  bool operator ==(Object other) => other is ActivityEvent && _listEquals(_props, other._props);
  @override
  int get hashCode => Object.hashAll(_props);
  @override
  String toString() => 'ActivityEvent($id, $type, $createdAt)';
}

/// 'morning' | 'evening' | 'adhoc'
typedef SessionType = String;

bool _listEquals(List<Object?> a, List<Object?> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
