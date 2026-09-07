/**
 * #276 判断3: メンタリング完了の機械判定（機能仕様
 * docs/features/work-approach-mentoring.md 判断3）。
 *
 * 完了と判定するのは「その朝会セッションに `kind = 'mentoring'` の
 * `decisions` 行が1件以上あり、かつそのセッションに `role = 'user'` の
 * メッセージが1件以上ある」の両方を満たすときのみ。記録の存在だけでは
 * 足りない — ボスの開始ひとこと（`meeting-opening.ts`）や、ユーザーが
 * 一言も話さないうちのツール呼び出しで条件を満たせてしまうと、対話の
 * 強制にならない（ADR 0008 が「夕会の存在のみを条件にし発言の有無を
 * 問わない」案を却下したのと同じ理由）。
 *
 * ADR 0004 決定2と同じ作法で、DB に一切触れない純粋関数にする。2つの
 * 件数（呼び出し側が `decisions-repository.ts` /
 * `messages-repository.ts` から読む）を受け取るだけ。
 */
export interface MentoringCompletionInput {
  /** 対象セッションの `kind = 'mentoring'` の decisions 件数。 */
  mentoringRecordCount: number;
  /** 対象セッションの `role = 'user'` の messages 件数。 */
  userMessageCount: number;
}

export function isMentoringComplete(input: MentoringCompletionInput): boolean {
  return input.mentoringRecordCount > 0 && input.userMessageCount > 0;
}
