import { useEffect, useRef, useState } from "react";
import { fetchWorkLog } from "./work-logs-api";
import { toDateKey } from "./to-date-key";
import type { WorkLog } from "./work-log";

export interface UseWorkLogResult {
  /** 現在選択中の日付（ローカル日付キー）。初期値は当日。 */
  selectedDate: string;
  /** 選択日の作業ログ。取得前・取得失敗時は null。 */
  workLog: WorkLog | null;
  /** 取得失敗時のエラーメッセージ。 */
  error: string | null;
  selectDate: (date: string) => void;
}

/**
 * 選択日の作業ログを取得するフック（Issue #161）。作業ログはサーバー側で
 * 都度生成される（保存なし・前提条件なし — 保証 G-170-44）ため、
 * 日付を選ぶだけで常に最新のデータから取得できる。
 *
 * 素早く A → B と日付を切り替えた場合に A の応答が B より後に届いても古い
 * 応答で状態を上書きしない stale-response ガードは `use-daily-reports.ts`
 * と同じ ref 方式。
 */
export function useWorkLog(): UseWorkLogResult {
  const [selectedDate, setSelectedDate] = useState(() => toDateKey(new Date()));
  const [workLog, setWorkLog] = useState<WorkLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRequestedDateRef = useRef(selectedDate);

  useEffect(() => {
    latestRequestedDateRef.current = selectedDate;
    // 取得中に前の日付の内容を表示したままにしない。日付入力は新しい日付を
    // 指しているのに本文が前日分のままだと、遅い回線で「表示中の日付と違う
    // 日のログをコピーして共有してしまう」事故が起きる（PR #165 レビュー指摘）。
    setWorkLog(null);
    setError(null);
    fetchWorkLog(selectedDate)
      .then((fetched) => {
        if (latestRequestedDateRef.current !== selectedDate) {
          return;
        }
        setWorkLog(fetched);
        setError(null);
      })
      .catch((err: unknown) => {
        if (latestRequestedDateRef.current !== selectedDate) {
          return;
        }
        setWorkLog(null);
        setError(
          err instanceof Error ? err.message : "作業ログの取得に失敗しました",
        );
      });
  }, [selectedDate]);

  return { selectedDate, workLog, error, selectDate: setSelectedDate };
}
