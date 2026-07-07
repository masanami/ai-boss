import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useSettings } from "./use-settings";
import {
  MAX_STRICTNESS,
  MIN_STRICTNESS,
  STRICTNESS_LABELS,
  TONE_PRESETS,
  TONE_PRESET_LABELS,
} from "./settings";
import type { Settings, TonePreset } from "./settings";
import "./SettingsView.css";

const STRICTNESS_OPTIONS = Array.from(
  { length: MAX_STRICTNESS - MIN_STRICTNESS + 1 },
  (_, index) => MIN_STRICTNESS + index,
);

/** Local, always-string-or-number form shape mirroring `Settings` 1:1 (`boss_custom_instructions` uses `""` instead of `null` for a controlled textarea). */
interface FormState {
  boss_name: string;
  boss_tone_preset: TonePreset;
  boss_strictness: number;
  boss_custom_instructions: string;
  work_start: string;
  work_end: string;
  morning_meeting_time: string;
  evening_meeting_time: string;
  detection_unstarted_fallback_minutes: number;
  detection_silence_fallback_minutes: number;
  detection_break_fallback_minutes: number;
  escalation_l2_after_minutes: number;
  escalation_l3_after_minutes: number;
  escalation_repeat_minutes: number;
  model: string;
}

function toFormState(settings: Settings): FormState {
  return {
    ...settings,
    boss_custom_instructions: settings.boss_custom_instructions ?? "",
  };
}

function SettingsView() {
  const { settings, status, saveError, isSaving, saveSettings } =
    useSettings();
  const [form, setForm] = useState<FormState | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (settings) {
      setForm(toFormState(settings));
    }
  }, [settings]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form === null || isSaving) {
      return;
    }
    setSaveSuccess(false);
    void saveSettings(form).then((saved) => {
      if (saved) {
        setSaveSuccess(true);
      }
    });
  };

  if (status === "error") {
    return (
      <section className="settings-view" aria-label="設定">
        <p role="alert">設定の取得に失敗しました</p>
      </section>
    );
  }

  // status === "ready" 直後、form を初期化する useEffect が走るまでの
  // 1フレームは form === null のため、エラーではなく読み込み表示を維持する
  if (status === "loading" || form === null) {
    return (
      <section className="settings-view" aria-label="設定">
        <p>読み込み中…</p>
      </section>
    );
  }

  return (
    <section className="settings-view" aria-label="設定">
      <form onSubmit={handleSubmit}>
        {/* 保存中は全フィールドを disabled にする。保存完了時に settings 再取得の
            useEffect が form を丸ごと上書きするため、保存中の編集を許すと
            その内容が無警告で消えてしまう */}
        <fieldset disabled={isSaving}>
          <legend>ボス人格</legend>
          <label>
            ボスの名前
            <input
              value={form.boss_name}
              onChange={(event) =>
                setForm({ ...form, boss_name: event.target.value })
              }
            />
          </label>
          <label>
            口調プリセット
            <select
              value={form.boss_tone_preset}
              onChange={(event) =>
                setForm({
                  ...form,
                  boss_tone_preset: event.target.value as TonePreset,
                })
              }
            >
              {TONE_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {TONE_PRESET_LABELS[preset]}
                </option>
              ))}
            </select>
          </label>
          <label>
            厳しさ
            <select
              value={form.boss_strictness}
              onChange={(event) =>
                setForm({
                  ...form,
                  boss_strictness: Number(event.target.value),
                })
              }
            >
              {STRICTNESS_OPTIONS.map((level) => (
                <option key={level} value={level}>
                  {level}: {STRICTNESS_LABELS[level]}
                </option>
              ))}
            </select>
          </label>
          <label>
            追加の指示
            <textarea
              value={form.boss_custom_instructions}
              onChange={(event) =>
                setForm({
                  ...form,
                  boss_custom_instructions: event.target.value,
                })
              }
            />
          </label>
        </fieldset>

        <fieldset disabled={isSaving}>
          <legend>セッション時刻</legend>
          <label>
            朝会の時刻
            <input
              type="time"
              value={form.morning_meeting_time}
              onChange={(event) =>
                setForm({
                  ...form,
                  morning_meeting_time: event.target.value,
                })
              }
            />
          </label>
          <label>
            夕会の時刻
            <input
              type="time"
              value={form.evening_meeting_time}
              onChange={(event) =>
                setForm({
                  ...form,
                  evening_meeting_time: event.target.value,
                })
              }
            />
          </label>
        </fieldset>

        <fieldset disabled={isSaving}>
          <legend>勤務時間帯</legend>
          <label>
            勤務開始
            <input
              type="time"
              value={form.work_start}
              onChange={(event) =>
                setForm({ ...form, work_start: event.target.value })
              }
            />
          </label>
          <label>
            勤務終了
            <input
              type="time"
              value={form.work_end}
              onChange={(event) =>
                setForm({ ...form, work_end: event.target.value })
              }
            />
          </label>
        </fieldset>

        <fieldset disabled={isSaving}>
          <legend>検知閾値</legend>
          <label>
            未着手のフォールバック（分）
            <input
              type="number"
              min={1}
              value={form.detection_unstarted_fallback_minutes}
              onChange={(event) =>
                setForm({
                  ...form,
                  detection_unstarted_fallback_minutes: Number(
                    event.target.value,
                  ),
                })
              }
            />
          </label>
          <label>
            無音のフォールバック（分）
            <input
              type="number"
              min={1}
              value={form.detection_silence_fallback_minutes}
              onChange={(event) =>
                setForm({
                  ...form,
                  detection_silence_fallback_minutes: Number(
                    event.target.value,
                  ),
                })
              }
            />
          </label>
          <label>
            休憩のフォールバック（分）
            <input
              type="number"
              min={1}
              value={form.detection_break_fallback_minutes}
              onChange={(event) =>
                setForm({
                  ...form,
                  detection_break_fallback_minutes: Number(
                    event.target.value,
                  ),
                })
              }
            />
          </label>
          <label>
            エスカレーション: レベル2まで（分）
            <input
              type="number"
              min={1}
              value={form.escalation_l2_after_minutes}
              onChange={(event) =>
                setForm({
                  ...form,
                  escalation_l2_after_minutes: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            エスカレーション: レベル3まで（分）
            <input
              type="number"
              min={1}
              value={form.escalation_l3_after_minutes}
              onChange={(event) =>
                setForm({
                  ...form,
                  escalation_l3_after_minutes: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            エスカレーション: 再通知間隔（分）
            <input
              type="number"
              min={1}
              value={form.escalation_repeat_minutes}
              onChange={(event) =>
                setForm({
                  ...form,
                  escalation_repeat_minutes: Number(event.target.value),
                })
              }
            />
          </label>
        </fieldset>

        <fieldset disabled={isSaving}>
          <legend>モデル</legend>
          <label>
            モデル
            <input
              value={form.model}
              onChange={(event) =>
                setForm({ ...form, model: event.target.value })
              }
            />
          </label>
        </fieldset>

        {saveError !== null && <p role="alert">{saveError}</p>}
        {saveError === null && saveSuccess && (
          <div className="settings-save-feedback">
            <p>保存しました</p>
            <p>設定は次回の応答・次回のチェックから反映されます</p>
          </div>
        )}

        <button type="submit" disabled={isSaving}>
          保存
        </button>
      </form>
    </section>
  );
}

export default SettingsView;
