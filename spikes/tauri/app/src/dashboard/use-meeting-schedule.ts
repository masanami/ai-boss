import { useCallback, useState } from "react";
import type { MeetingScheduleResponse, MeetingSchedulePatch } from "./meeting-schedule";

// スパイク: 元の useMeetingSchedule（/api/meeting-schedule）をメモリ上のダミーに差し替える。
const INITIAL: MeetingScheduleResponse = {
  date: "2026-09-23",
  morning: { time: "09:00", defaultTime: "09:00", overridden: false, latestAllowedTime: "23:59" },
  evening: { time: "18:00", defaultTime: "18:00", overridden: false, latestAllowedTime: "23:59" },
};

export function useMeetingSchedule() {
  const [schedule, setSchedule] = useState<MeetingScheduleResponse>(INITIAL);
  const saveSchedule = useCallback(async (patch: MeetingSchedulePatch) => {
    setSchedule((s) => {
      const next = { ...s };
      for (const type of ["morning", "evening"] as const) {
        if (!(type in patch)) continue;
        const time = patch[type] ?? s[type].defaultTime;
        next[type] = { ...s[type], time, overridden: time !== s[type].defaultTime };
      }
      return next;
    });
    return true;
  }, []);
  return { schedule, status: "ready" as "loading" | "ready" | "error", saveError: null, isSaving: false, saveSchedule };
}
