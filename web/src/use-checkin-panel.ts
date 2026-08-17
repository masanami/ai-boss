import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTodayActivity, postCheckin } from "./checkins-api";
import { deriveIsOnBreak } from "./derive-break-status";
import type { ActivityEvent, CheckinInput } from "./activity-event";

export type ActivityLoadStatus = "loading" | "ready" | "error";

export interface UseCheckinPanelResult {
  events: ActivityEvent[];
  status: ActivityLoadStatus;
  isOnBreak: boolean;
  submitError: string | null;
  /** 送信中フラグ。UI 側でボタンを無効化するために公開する */
  isSubmitting: boolean;
  submitCheckin: (input: CheckinInput) => Promise<boolean>;
}

/**
 * Loads today's activity events on mount and exposes a `submitCheckin`
 * action that posts an explicit checkin, then refetches the list so the
 * panel reflects the new state. Mirrors the fetch-on-mount pattern used by
 * `useTasks`.
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

  useEffect(() => {
    let cancelled = false;

    fetchTodayActivity()
      .then((fetched) => {
        if (!cancelled) {
          setEvents(fetched);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // 連打（二重クリック）で POST /api/checkins が多重発火し activity_events に
  // 重複記録されるのを防ぐ。ref は同期的な再入ガード、state は UI の無効化用。
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
      // fetchTodayActivity が reject するとここに到達しなくなり、ボードが
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
      const refetched = await fetchTodayActivity();
      setEvents(refetched);
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
  }, [refreshTasks]);

  return {
    events,
    status,
    isOnBreak: deriveIsOnBreak(events),
    submitError,
    isSubmitting,
    submitCheckin,
  };
}
