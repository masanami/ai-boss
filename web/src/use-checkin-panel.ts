import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTodayActivity, postCheckin } from "./checkins-api";
import { deriveIsOnBreak } from "./derive-break-status";
import type { ActivityEvent, CheckinInput } from "./activity-event";
import type { TaskPatchInput } from "./task";

export type ActivityLoadStatus = "loading" | "ready" | "error";

export interface UseCheckinPanelResult {
  events: ActivityEvent[];
  status: ActivityLoadStatus;
  isOnBreak: boolean;
  submitError: string | null;
  /** 送信中フラグ。UI 側でボタンを無効化するために公開する */
  isSubmitting: boolean;
  submitCheckin: (input: CheckinInput) => Promise<boolean>;
  /** 複数のチェックインを**直列**に送信する（#243 判断 6 の
   * `break_start` → `break_end`）。POST は順に送り、最初に失敗した時点で
   * 打ち切る。全件送れたら tasks 再取得 → 活動再取得を 1 回だけ行う。
   * 戻り値の `posted` は 201 を受けた件数、`ok` は全件送れたか。
   * `submitCheckin` と違い、**送信後の再取得の失敗は `ok` に含めない**
   * （Codex 指摘 PR #354: 再取得の一時的な失敗を 1 件目の失敗と
   * 区別できないと、2 件目の `break_end` が送られず休憩が開いたままになる）。
   * 再取得の失敗は活動一覧側の status で表示される。 */
  submitCheckins: (
    inputs: CheckinInput[],
  ) => Promise<{ posted: number; ok: boolean }>;
  /** 今日の活動を再取得する。マウント時読み込み・submitCheckin・
   * completeTask（Issue #138）が共有する内部処理だが、既存の
   * use-checkin-panel.test.ts のテストパターン（フックの各アクションを
   * 直接呼んで検証する）に合わせてテスト容易性のために公開している。
   * CheckinPanel からは直接呼ばれない（completeTask 経由で間接的に使う）。 */
  reloadEvents: () => Promise<void>;
  /** 選択中タスクを完了（status: "done"）にする。「完了」ボタン（Issue #138）
   * 用のアクション。submitCheckin と同じ送信中フラグ・エラー state・
   * 再入ガードを共有し、着手/休憩と完了が同時に走らないようにする。
   * editTask は呼び出し元（CheckinPanel）が受け取る共有 tasksState 由来の
   * ものをそのまま渡す（本フックは tasksState を持たないため）。 */
  completeTask: (
    taskId: number,
    editTask: (id: number, patch: TaskPatchInput) => Promise<void>,
  ) => Promise<boolean>;
}

/**
 * Loads today's activity events on mount and exposes two mutation actions
 * that share the same in-flight guard and error state: `submitCheckin`
 * (posts an explicit checkin) and `completeTask` (Issue #138; marks the
 * selected task done via the caller-provided `editTask`). Both refetch the
 * activity list on success so the panel reflects the new state. Mirrors the
 * fetch-on-mount pattern used by `useTasks`.
 *
 * @param refreshTasks - The shared `useTasks().refresh` from `AppLayout`
 * (Issue #70 lift-up). Called after a successful checkin so status changes
 * driven by the checkin (e.g. task_start moving a task to in_progress,
 * Issue #133) are reflected on the task board without a reload. Not called
 * on failure, and checkin types that don't change task status re-fetch
 * idempotently (Issue #134).
 */
export function useCheckinPanel(
  refreshTasks: () => Promise<void>,
): UseCheckinPanelResult {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [status, setStatus] = useState<ActivityLoadStatus>("loading");
  const [submitError, setSubmitError] = useState<string | null>(null);

  // 「完了」ボタン（reloadEvents 経由）がマウント時の初回読み込みより先に
  // 解決した場合、後から到着する初回読み込みの遅延レスポンスが新しい結果を
  // 巻き戻さないよう、世代番号で最新リクエストの応答だけを反映する
  // （use-tasks.ts の refresh と同じパターン、Issue #138 レビュー指摘）。
  // events だけでなく status もこの世代ガードの対象にする（完了操作による
  // 再取得の成功/失敗が status にも正しく反映され、旧世代の応答で巻き戻ら
  // ないようにするため）。呼び出し元（submitCheckin/completeTask）は失敗を
  // 検知して submitError を出す必要があるため、失敗時は status を更新した
  // 上でエラーを rethrow し、呼び出し元の catch に処理を委ねる。
  const eventsGenerationRef = useRef(0);

  const reloadEvents = useCallback(async () => {
    const generation = ++eventsGenerationRef.current;
    try {
      const fetched = await fetchTodayActivity();
      if (generation !== eventsGenerationRef.current) {
        return;
      }
      setEvents(fetched);
      setStatus("ready");
    } catch (error) {
      if (generation === eventsGenerationRef.current) {
        setStatus("error");
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    reloadEvents().catch(() => {
      // no-op: 失敗時の status 更新は reloadEvents 内で既に行われている。
      // ここでは unhandled promise rejection 化を防ぐためだけに捕捉する。
    });
  }, [reloadEvents]);

  // 連打（二重クリック）で POST /api/checkins・PATCH /api/tasks/:id が多重
  // 発火するのを防ぐ。ref は同期的な再入ガード、state は UI の無効化用。
  // submitCheckin（着手/休憩/戻り）と completeTask（完了）は同じ送信中
  // フラグ・エラー state を共有し、一方の実行中はもう一方も無効化される
  // （Issue #138 レビュー指摘: 個別の state だと相互に排他できなかった）。
  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitCheckin = useCallback(async (input: CheckinInput) => {
    if (submittingRef.current) {
      return false;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      await postCheckin(input);
      setSubmitError(null);
      // チェックイン成功の時点でサーバ側のタスク status 遷移は確定している
      // ため、tasks 再取得は活動履歴の再取得より先に必ず実行する（後続の
      // reloadEvents が reject するとここに到達しなくなり、ボードが
      // 古い todo のまま残る＝レビュー指摘）。ベストエフォート扱いにするのは
      // 従来どおり: refreshTasks は現状 use-tasks.ts の refresh（内部で
      // fetch エラーを catch し reject しない）のみが実引数だが、その契約は
      // 型（() => Promise<void>）では保証されない。ここで吸収しておかないと、
      // refreshTasks が reject した場合に成功したチェックインが失敗として
      // 報告されてしまう（レビュー指摘）。
      try {
        await refreshTasks();
      } catch {
        // no-op: tasks 再取得の失敗はチェックインの成否に影響させない
      }
      await reloadEvents();
      return true;
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "送信に失敗しました",
      );
      return false;
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [refreshTasks, reloadEvents]);

  const submitCheckins = useCallback(
    async (inputs: CheckinInput[]) => {
      if (submittingRef.current) {
        return { posted: 0, ok: false };
      }
      submittingRef.current = true;
      setIsSubmitting(true);
      let posted = 0;
      // 1 件でも POST が確定したら、成否にかかわらず再取得する（submitCheckin
      // と同じ順: tasks → 活動）。途中で失敗した場合も、記録済みのイベントを
      // 活動一覧へ反映して isOnBreak 等の導出を実状態に合わせるため。
      // いずれの再取得の失敗も送信結果（ok）には含めない。
      const refreshAfterPosts = async () => {
        if (posted === 0) return;
        try {
          await refreshTasks();
        } catch {
          // no-op: tasks 再取得の失敗はチェックインの成否に影響させない
        }
        try {
          await reloadEvents();
        } catch {
          // no-op: 活動一覧側の status が "error" になり、そちらで表示される
        }
      };
      try {
        for (const input of inputs) {
          try {
            await postCheckin(input);
          } catch (error) {
            setSubmitError(
              error instanceof Error ? error.message : "送信に失敗しました",
            );
            await refreshAfterPosts();
            return { posted, ok: false };
          }
          posted += 1;
        }
        setSubmitError(null);
        await refreshAfterPosts();
        return { posted, ok: true };
      } finally {
        submittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [refreshTasks, reloadEvents],
  );

  const completeTask = useCallback(
    async (
      taskId: number,
      editTask: (id: number, patch: TaskPatchInput) => Promise<void>,
    ) => {
      if (submittingRef.current) {
        return false;
      }
      submittingRef.current = true;
      setIsSubmitting(true);
      try {
        await editTask(taskId, { status: "done" });
        setSubmitError(null);
        // editTask（use-tasks.ts）は成功時に共有 tasks state を自ら更新
        // 済みのため、submitCheckin と異なり tasks 再取得は不要。完了自体は
        // この時点で確定しているため、活動履歴の再取得失敗を完了操作の失敗
        // として扱わない（reloadEvents 内で status が "error" になり履歴側の
        // エラー表示に委ねる。PR #146 レビュー指摘）。
        try {
          await reloadEvents();
        } catch {
          // no-op: 履歴再取得の失敗は完了の成否に影響させない
        }
        return true;
      } catch (error) {
        setSubmitError(
          error instanceof Error ? error.message : "送信に失敗しました",
        );
        return false;
      } finally {
        submittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [reloadEvents],
  );

  return {
    events,
    status,
    isOnBreak: deriveIsOnBreak(events),
    submitError,
    isSubmitting,
    submitCheckin,
    submitCheckins,
    reloadEvents,
    completeTask,
  };
}
