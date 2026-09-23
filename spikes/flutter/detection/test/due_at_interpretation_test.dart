import 'dart:io';
import 'package:test/test.dart';

// due-at-interpretation.test.ts の移植（AC-10: due_at の解釈は due_at.dart に集約され、
// 検知ルールは due_at から日時を直接組み立てない）。Dart 版では deadline-overdue / priority が rules.dart に同居する。
const guardedFiles = ['lib/src/rules.dart'];

// DateTime.parse / DateTime.tryParse / jsParse の引数に due_at 由来の識別子が現れる形
final newDateFromDueAt = RegExp(r'(DateTime\.(try)?[pP]arse|jsParse|jsTime)\s*\([^)]*due_?at[^)]*\)', caseSensitive: false);

String stripComments(String source) => source.replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '').replaceAll(RegExp(r'//.*$', multiLine: true), '');

void main() {
  group('detection engine does not interpret due_at itself (AC-10)', () {
    for (final fileName in guardedFiles) {
      test('$fileName contains no date parsing built from due_at', () {
        expect(stripComments(File(fileName).readAsStringSync()), isNot(matches(newDateFromDueAt)));
      });

      test('$fileName delegates to due_at.dart', () {
        expect(stripComments(File(fileName).readAsStringSync()), contains('toDueAtInstant'));
      });
    }

    test('the guard pattern actually matches the shape it is meant to forbid', () {
      expect('return DateTime.parse(task.dueAt).millisecondsSinceEpoch < now;', matches(newDateFromDueAt));
      expect('final t = jsParse(dueAt);', matches(newDateFromDueAt));
      expect('final t = DateTime.parse(startOfNextLocalDayIso(localDay));', isNot(matches(newDateFromDueAt)));
    });
  });
}
