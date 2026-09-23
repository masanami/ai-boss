// 全テストを 1 プロセスで走らせるための集約（`dart test` の代わりに `dart test/all_test.dart` で実行する）
import 'avoidance_test.dart' as avoidance;
import 'break_overrun_test.dart' as break_overrun;
import 'commitment_missed_test.dart' as commitment_missed;
import 'deadline_overdue_test.dart' as deadline_overdue;
import 'due_at_interpretation_test.dart' as due_at_interpretation;
import 'escalation_test.dart' as escalation;
import 'meeting_test.dart' as meeting;
import 'priority_test.dart' as priority;
import 'rule_engine_a_test.dart' as rule_engine_a;
import 'rule_engine_b_test.dart' as rule_engine_b;
import 'rule_engine_c_test.dart' as rule_engine_c;
import 'silence_test.dart' as silence;
import 'time_utils_test.dart' as time_utils;
import 'unstarted_test.dart' as unstarted;

void main() {
  avoidance.main();
  break_overrun.main();
  commitment_missed.main();
  deadline_overdue.main();
  due_at_interpretation.main();
  escalation.main();
  meeting.main();
  priority.main();
  rule_engine_a.main();
  rule_engine_b.main();
  rule_engine_c.main();
  silence.main();
  time_utils.main();
  unstarted.main();
}
