import { useCallback, useEffect, useRef, useState } from "react";
import type { DecisionRecord } from "./decision";
import { fetchDecisions } from "./decisions-api";
import type { Task } from "./task";
import {
  detectTaskStarts,
  isMentoringUnconfirmed,
} from "./task-start-mentoring";

export interface UseTaskStartMentoringPromptResult {
  /** 表示中の促しの対象タスク。`null` なら促しは出ていない。 */
  promptTask: Task | null;
  /** 促しを閉じる（「あとで」「メンタリングする」のどちらでも呼ぶ）。 */
  dismiss: () => void;
}

/**
 * タスク着手時のメンタリングの促し（Issue #566 S1）。共有 `tasks` の前回値
 * との比較で `todo` → `in_progress` を検知し、未確認なら促しの対象にする。
 *
 * `canPrompt` はタスクカードの「メンタリングする」が出せるか（`adhoc` 区間
 * かつチャット状態 ready。決定6）。出せないときは促さず、促し済みにも入れない。
 * 表示中に出せなくなったら（会の開始など）促しを閉じる。
 *
 * 判定の完了順（決定8・#568 で改訂）: 遷移を検知するたびに通し番号を振り、
 * 「未確認」と分かった時点でその番号が**最後に表示した促しの番号**より新しい
 * 場合だけ表示する。`use-tasks.ts` の `generationRef` は「最新の呼び出し」と
 * 比べるが、ここで「最新の遷移」と比べると、後続の遷移が促しを生まなかった
 * とき（確認済み・促し済み・取得失敗）に先行の適格な促しまで捨ててしまう。
 *
 * 促しはページ内の状態のみで、永続化しない（決定4）。
 */
export function useTaskStartMentoringPrompt(
  tasks: Task[],
  canPrompt: boolean,
): UseTaskStartMentoringPromptResult {
  // 検知時点のタスク。表示は最新の `tasks` から id で引き直す（改名に追随する）
  // が、一覧から消えていてもこれで出し続ける（促しは自動で消えない。決定4）。
  const [shownTask, setShownTask] = useState<Task | null>(null);
  // 初回は空配列＝前回値なし。読み込み直後の `in_progress` は遷移にならない（AC-11）。
  const previousTasksRef = useRef<Task[]>([]);
  const transitionSeqRef = useRef(0);
  // 0 は「まだ一度も表示していない」。番号は 1 から振るので、どの遷移も新しい。
  const lastShownSeqRef = useRef(0);
  // 促しを表示したタスクの id（1 タスク 1 回。FR-6）。**描画が確定してから**
  // 入れる（下の effect）。判定の側で入れると、描画前に続けて完了した判定
  // （共有の取得の応答・同時に完了した別々の取得・同じ更新の複数の着手）が
  // React にまとめられ、描画されなかった先のタスクまで促し済みになる（PR #572）。
  const promptedTaskIdsRef = useRef(new Set<number>());
  // 取得完了時点の可否で判断するため、最新値を ref で持つ。下の遷移検知より
  // 先に宣言し、同じコミットで両方が変わっても新しい可否で判断させる。
  const canPromptRef = useRef(canPrompt);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    canPromptRef.current = canPrompt;
    if (!canPrompt) {
      setShownTask(null);
    }
  }, [canPrompt]);

  // 遷移検知より先に宣言し、同じコミットで検知が走っても先に促し済みへ入れる。
  useEffect(() => {
    if (shownTask !== null) {
      promptedTaskIdsRef.current.add(shownTask.id);
    }
  }, [shownTask]);

  useEffect(() => {
    const previous = previousTasksRef.current;
    previousTasksRef.current = tasks;

    const showIfNewest = (seq: number, task: Task) => {
      if (!mountedRef.current || !canPromptRef.current) {
        return;
      }
      if (seq <= lastShownSeqRef.current) {
        return;
      }
      // 同じタスクの判定が並行して完了しても 2 回表示しない（FR-6）。
      if (promptedTaskIdsRef.current.has(task.id)) {
        return;
      }
      // 描画前に続けて呼ばれたら、最後の（番号の最も新しい）1 件だけが描画
      // され、促し済みになる（上の effect）。
      lastShownSeqRef.current = seq;
      setShownTask(task);
    };

    // 同じ更新で見積もりありの遷移が複数あっても、取得は 1 回にまとめる。
    let decisionsRequest: Promise<DecisionRecord[]> | null = null;

    for (const task of detectTaskStarts(previous, tasks)) {
      // 促しを出すかどうかにかかわらず、遷移ごとに番号を進める（決定8）。
      const seq = ++transitionSeqRef.current;
      if (!canPromptRef.current || promptedTaskIdsRef.current.has(task.id)) {
        continue;
      }
      if (task.estimated_minutes === null) {
        showIfNewest(seq, task);
        continue;
      }
      // その場で取得する（決定3: 保持した一覧ではメンタリング直後に古くなる）。
      // 取得失敗は促さない側に倒し、画面にも出さない（fail-closed）。
      decisionsRequest ??= fetchDecisions();
      decisionsRequest.then(
        (decisions) => {
          if (isMentoringUnconfirmed(task, decisions)) {
            showIfNewest(seq, task);
          }
        },
        () => {},
      );
    }
  }, [tasks]);

  const dismiss = useCallback(() => {
    setShownTask(null);
  }, []);

  const promptTask =
    shownTask === null
      ? null
      : (tasks.find((task) => task.id === shownTask.id) ?? shownTask);

  return { promptTask, dismiss };
}
