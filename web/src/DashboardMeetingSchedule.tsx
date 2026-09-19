import { useEffect, useState } from "react";
import { useMeetingSchedule } from "./use-meeting-schedule";
import type { MeetingType, MeetingSchedulePatch } from "./meeting-schedule";
import "./DashboardMeetingSchedule.css";

const MEETING_TYPES: readonly MeetingType[] = ["morning", "evening"];

const MEETING_TYPE_LABELS: Record<MeetingType, string> = {
  morning: "朝会",
  evening: "夕会",
};

interface FormState {
  morning: string;
  evening: string;
}

function toFormState(schedule: {
  morning: { time: string };
  evening: { time: string };
}): FormState {
  return { morning: schedule.morning.time, evening: schedule.evening.time };
}

/**
 * 今日の朝会・夕会の予定時刻をダッシュボードに表示し、当日限りの変更・
 * 取り消しを行うセクション（Issue #434 /
 * docs/features/today-meeting-time-override.md）。
 *
 * `GET /api/dashboard` の応答スキーマには相乗りせず（決定9）、
 * `/api/meeting-schedule/:date` を直接読み書きする。
 */
function DashboardMeetingSchedule() {
  const { schedule, status, saveError, isSaving, saveSchedule } =
    useMeetingSchedule();
  const [form, setForm] = useState<FormState | null>(null);

  useEffect(() => {
    if (schedule) {
      setForm(toFormState(schedule));
    }
  }, [schedule]);

  const handleSave = () => {
    if (form === null || isSaving) {
      return;
    }
    const patch: MeetingSchedulePatch = {
      morning: form.morning,
      evening: form.evening,
    };
    void saveSchedule(patch);
  };

  const handleReset = (type: MeetingType) => {
    if (isSaving) {
      return;
    }
    void saveSchedule({ [type]: null });
  };

  if (status === "error") {
    return (
      <section
        className="dashboard-meeting-schedule"
        aria-label="今日の会の予定時刻"
      >
        <h2>今日の会</h2>
        <p role="alert">今日の会の予定時刻の取得に失敗しました</p>
      </section>
    );
  }

  // status === "ready" 直後、form を初期化する useEffect が走るまでの
  // 1フレームは form === null のため、エラーではなく読み込み表示を維持する
  // （SettingsView.tsx と同じ理由）。
  if (status === "loading" || schedule === null || form === null) {
    return (
      <section
        className="dashboard-meeting-schedule"
        aria-label="今日の会の予定時刻"
      >
        <h2>今日の会</h2>
        <p>読み込み中…</p>
      </section>
    );
  }

  return (
    <section
      className="dashboard-meeting-schedule"
      aria-label="今日の会の予定時刻"
    >
      <h2>今日の会</h2>

      {MEETING_TYPES.map((type) => {
        const slot = schedule[type];
        return (
          <p key={type}>
            {MEETING_TYPE_LABELS[type]} {slot.time}
            {slot.overridden && (
              <span>（既定 {slot.defaultTime} から変更）</span>
            )}
          </p>
        );
      })}

      <fieldset disabled={isSaving}>
        {MEETING_TYPES.map((type) => {
          const slot = schedule[type];
          return (
            <label key={type}>
              {MEETING_TYPE_LABELS[type]}
              <input
                type="time"
                max={slot.latestAllowedTime}
                value={form[type]}
                onChange={(event) =>
                  setForm({ ...form, [type]: event.target.value })
                }
              />
            </label>
          );
        })}
      </fieldset>

      {saveError !== null && <p role="alert">{saveError}</p>}

      <button type="button" onClick={handleSave} disabled={isSaving}>
        保存
      </button>

      {MEETING_TYPES.map((type) =>
        schedule[type].overridden ? (
          <button
            key={type}
            type="button"
            aria-label={`${MEETING_TYPE_LABELS[type]}を既定に戻す`}
            onClick={() => handleReset(type)}
            disabled={isSaving}
          >
            既定に戻す
          </button>
        ) : null,
      )}
    </section>
  );
}

export default DashboardMeetingSchedule;
