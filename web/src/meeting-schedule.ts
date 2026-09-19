/**
 * Frontend-local mirror of the `GET/PUT /api/meeting-schedule/:date` response
 * shape (`server/src/meeting-schedule/meeting-schedule-routes.ts`, Issue
 * #432 / #434). Kept as a separate type (rather than importing the server
 * module) to match the existing pattern of `dashboard-response.ts` /
 * `settings.ts`, which mirror their respective server shapes.
 */

export type MeetingType = "morning" | "evening";

export interface MeetingSlotResponse {
  /** その日の実効時刻（上書きがあれば上書き時刻、無ければ `defaultTime`） */
  time: string;
  /** 恒常設定の時刻 */
  defaultTime: string;
  /** `time !== defaultTime`（実効時刻が恒常設定と違うか） */
  overridden: boolean;
  /** 指定できる最も遅い時刻。時刻入力の `max` に使う */
  latestAllowedTime: string;
}

export interface MeetingScheduleResponse {
  date: string;
  morning: MeetingSlotResponse;
  evening: MeetingSlotResponse;
}

/**
 * `PUT /api/meeting-schedule/:date` のリクエストボディ。`null` は「その種別
 * の上書きを削除して既定へ戻す」ことを意味する。指定しなかった種別は変更
 * しない。
 */
export type MeetingSchedulePatch = Partial<Record<MeetingType, string | null>>;
