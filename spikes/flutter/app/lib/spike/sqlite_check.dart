import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

// 項目 2: drift で tasks 相当を作成・読み書き（build_runner のコード生成を避け、生 SQL の API だけを使う）。
class SpikeDatabase extends GeneratedDatabase {
  SpikeDatabase() : super(driftDatabase(name: 'aiboss_spike'));
  @override
  Iterable<TableInfo<Table, dynamic>> get allTables => const [];
  @override
  int get schemaVersion => 1;
}

const _createTasks = '''
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'work',
  priority TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'paused', 'done', 'dropped')),
  boss_comment TEXT,
  estimated_minutes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  evidence_required INTEGER NOT NULL DEFAULT 0,
  committed_start_at TEXT,
  committed_at TEXT
)''';

Future<Map<String, Object?>> runSqliteCheck() async {
  final sw = Stopwatch()..start();
  final db = SpikeDatabase();
  await db.customStatement(_createTasks);
  final now = DateTime.now().toUtc().toIso8601String();
  final id = await db.customInsert(
    "INSERT INTO tasks (title, category, status, created_at, updated_at, evidence_required) VALUES (?, 'work', 'todo', ?, ?, 1)",
    variables: [Variable.withString('スパイク: 資料作成'), Variable.withString(now), Variable.withString(now)],
  );
  await db.customUpdate("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?", variables: [Variable.withString(now), Variable.withInt(id)]);
  final rows = await db.customSelect('SELECT id, title, status FROM tasks ORDER BY created_at ASC, id ASC').get();

  // better-sqlite3 の db.transaction() 相当: drift の transaction は同一接続で直列化される
  String transactionProbe;
  try {
    await db.transaction(() async {
      await db.customInsert("INSERT INTO tasks (title, created_at, updated_at) VALUES ('rollback-probe', ?, ?)", variables: [Variable.withString(now), Variable.withString(now)]);
      throw StateError('rollback');
    });
    transactionProbe = 'no-throw';
  } on StateError {
    final n = await db.customSelect("SELECT COUNT(*) AS n FROM tasks WHERE title = 'rollback-probe'").getSingle();
    transactionProbe = n.read<int>('n') == 0 ? 'rollback-effective' : 'rollback-NOT-effective';
  }
  await db.close();
  return {
    'ok': rows.any((r) => r.read<int>('id') == id && r.read<String>('status') == 'in_progress'),
    'count': rows.length,
    'lastInsertId': id,
    'transactionProbe': transactionProbe,
    'elapsedMs': sw.elapsedMilliseconds,
  };
}
