import { useCallback, useEffect, useState } from "react";
import { fetchMeetingSchedule, updateMeetingSchedule } from "./meeting-schedule-api";
import type { MeetingScheduleResponse, MeetingSchedulePatch } from "./meeting-schedule";
import { toDateKey } from "./to-date-key";

export type MeetingScheduleLoadStatus = "loading" | "ready" | "error";

export interface UseMeetingScheduleResult {
  schedule: MeetingScheduleResponse | null;
  status: MeetingScheduleLoadStatus;
  saveError: string | null;
  /** 保存中フラグ。UI 側で保存・既定に戻すボタンを無効化するために公開する */
  isSaving: boolean;
  saveSchedule: (patch: MeetingSchedulePatch) => Promise<boolean>;
}

/**
 * 当日の朝会・夕会の予定時刻（`GET/PUT /api/meeting-schedule/:date`）を扱う
 * フック。`useSettings` / `useDailyReports` の fetch-on-mount /
 * submit-with-error-state パターンを踏襲する。
 *
 * 日付キーはマウント時に一度だけ `toDateKey(new Date())` で確定し（当日限り
 * の API のため、日をまたいで開きっぱなしにするケースは本チケットのスコープ
 * 外）、GET・PUT の両方でその値を使う。
 */
export function useMeetingSchedule(): UseMeetingScheduleResult {
  const [dateKey] = useState(() => toDateKey(new Date()));
  const [schedule, setSchedule] = useState<MeetingScheduleResponse | null>(null);
  const [status, setStatus] = useState<MeetingScheduleLoadStatus>("loading");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetchMeetingSchedule(dateKey)
      .then((fetched) => {
        if (!cancelled) {
          setSchedule(fetched);
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
  }, [dateKey]);

  const saveSchedule = useCallback(
    async (patch: MeetingSchedulePatch) => {
      setIsSaving(true);
      try {
        // PUT の応答をそのまま表示更新に使う。PUT 後に GET を撃ち直さない
        // （docs/features/today-meeting-time-override.md 決定9・AC-47）。
        const updated = await updateMeetingSchedule(dateKey, patch);
        setSchedule(updated);
        setSaveError(null);
        return true;
      } catch (error) {
        setSaveError(
          error instanceof Error ? error.message : "保存に失敗しました",
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [dateKey],
  );

  return { schedule, status, saveError, isSaving, saveSchedule };
}
