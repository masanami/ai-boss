import { useCallback, useEffect, useState } from "react";
import { fetchSettings, updateSettings } from "./settings-api";
import type { Settings, SettingsPatch, SettingsWarning } from "./settings";

export type SettingsLoadStatus = "loading" | "ready" | "error";

export interface UseSettingsResult {
  settings: Settings | null;
  status: SettingsLoadStatus;
  saveError: string | null;
  /**
   * 直前の保存の警告（#708 決定 22）。保存を始めた時点で空にし、成功した
   * 保存の応答の warnings に置き換える（失敗したときは空のまま）。前回の
   * 警告を閉じた・見たという状態は持たない。
   */
  saveWarnings: SettingsWarning[];
  /** 保存中フラグ。UI 側で保存ボタンを無効化するために公開する */
  isSaving: boolean;
  saveSettings: (patch: SettingsPatch) => Promise<boolean>;
}

/**
 * Loads the effective settings on mount and exposes a `saveSettings` action
 * that PUTs a patch and replaces the local state with the server's
 * post-write effective values on success. On failure, `settings` is left
 * untouched (the form keeps whatever the user typed) and `saveError` holds
 * the server-provided message. Mirrors the fetch-on-mount /
 * submit-with-error-state pattern used by `useCheckinPanel`.
 */
export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<SettingsLoadStatus>("loading");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveWarnings, setSaveWarnings] = useState<SettingsWarning[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetchSettings()
      .then((fetched) => {
        if (!cancelled) {
          setSettings(fetched);
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

  const saveSettings = useCallback(async (patch: SettingsPatch) => {
    setIsSaving(true);
    setSaveWarnings([]);
    try {
      const updated = await updateSettings(patch);
      setSettings(updated.settings);
      setSaveWarnings(updated.warnings);
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
  }, []);

  return { settings, status, saveError, saveWarnings, isSaving, saveSettings };
}
