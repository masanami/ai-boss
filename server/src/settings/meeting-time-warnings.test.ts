import { describe, expect, it } from "vitest";
import {
  findMeetingTimeWarnings,
  MEETING_OUTSIDE_WORKING_HOURS_CODE,
  type MeetingTimeWarningInput,
} from "./meeting-time-warnings.js";

// 会の時刻と稼働時間帯の整合警告（#708・機能仕様
// docs/features/working-hours-intervals.md 決定 17〜22・受入基準（S4））。
// 判定は HH:mm の文字列だけを見る純粋関数のため、現在時刻・DB を使わない。

const DEFAULTS: MeetingTimeWarningInput = {
  work_start: "09:00",
  work_end: "18:00",
  morning_meeting_time: "09:00",
  evening_meeting_time: "18:00",
};

function keysOf(input: Partial<MeetingTimeWarningInput>): string[] {
  return findMeetingTimeWarnings({ ...DEFAULTS, ...input }).map((w) => w.key);
}

describe("findMeetingTimeWarnings — 帯の境界（決定 19。両端を含む）", () => {
  it("朝会 09:00（= work_start）のとき、朝会の警告は出ない", () => {
    expect(keysOf({ morning_meeting_time: "09:00" })).not.toContain(
      "morning_meeting_time",
    );
  });

  it("朝会 08:59 のとき、朝会の警告が 1 件出る", () => {
    expect(keysOf({ morning_meeting_time: "08:59" })).toEqual([
      "morning_meeting_time",
    ]);
  });

  it("朝会 18:00（= work_end）のとき、朝会の警告は出ない", () => {
    expect(keysOf({ morning_meeting_time: "18:00" })).not.toContain(
      "morning_meeting_time",
    );
  });

  it("朝会 18:01 のとき、朝会の警告が 1 件出る", () => {
    expect(keysOf({ morning_meeting_time: "18:01" })).toEqual([
      "morning_meeting_time",
    ]);
  });

  it("夕会 18:00（= work_end）のとき、夕会の警告は出ない", () => {
    expect(keysOf({ evening_meeting_time: "18:00" })).not.toContain(
      "evening_meeting_time",
    );
  });

  it("夕会 18:01 のとき、夕会の警告が 1 件出る", () => {
    expect(keysOf({ evening_meeting_time: "18:01" })).toEqual([
      "evening_meeting_time",
    ]);
  });

  it("夕会 09:00（= work_start）のとき、夕会の警告は出ない", () => {
    expect(keysOf({ evening_meeting_time: "09:00" })).not.toContain(
      "evening_meeting_time",
    );
  });

  it("夕会 08:59 のとき、夕会の警告が 1 件出る", () => {
    expect(keysOf({ evening_meeting_time: "08:59" })).toEqual([
      "evening_meeting_time",
    ]);
  });

  it("既定の組（帯 09:00-18:00・朝会 09:00・夕会 18:00）のとき、警告は 0 件である", () => {
    expect(findMeetingTimeWarnings(DEFAULTS)).toEqual([]);
  });

  it("帯 07:00-22:00・朝会 06:59・夕会 22:00 のとき、警告は朝会の 1 件だけである", () => {
    expect(
      keysOf({
        work_start: "07:00",
        work_end: "22:00",
        morning_meeting_time: "06:59",
        evening_meeting_time: "22:00",
      }),
    ).toEqual(["morning_meeting_time"]);
  });

  it("朝会 08:00・夕会 19:00 のとき、警告は 2 件で、1 件目が朝会・2 件目が夕会である", () => {
    expect(
      keysOf({ morning_meeting_time: "08:00", evening_meeting_time: "19:00" }),
    ).toEqual(["morning_meeting_time", "evening_meeting_time"]);
  });
});

describe("findMeetingTimeWarnings — 警告 1 件の形（決定 18・22）", () => {
  it("警告の code は meeting_outside_working_hours である", () => {
    const warnings = findMeetingTimeWarnings({
      ...DEFAULTS,
      morning_meeting_time: "08:00",
      evening_meeting_time: "19:00",
    });
    expect(MEETING_OUTSIDE_WORKING_HOURS_CODE).toBe(
      "meeting_outside_working_hours",
    );
    expect(warnings.map((w) => w.code)).toEqual([
      "meeting_outside_working_hours",
      "meeting_outside_working_hours",
    ]);
  });

  it("朝会の警告の key は morning_meeting_time、夕会の警告の key は evening_meeting_time である", () => {
    const [morning, evening] = findMeetingTimeWarnings({
      ...DEFAULTS,
      morning_meeting_time: "08:00",
      evening_meeting_time: "19:00",
    });
    expect(morning.key).toBe("morning_meeting_time");
    expect(evening.key).toBe("evening_meeting_time");
  });

  it("帯 09:00-18:00・朝会 08:30 の警告の message は受入基準の文面である", () => {
    expect(
      findMeetingTimeWarnings({ ...DEFAULTS, morning_meeting_time: "08:30" }),
    ).toEqual([
      {
        code: "meeting_outside_working_hours",
        key: "morning_meeting_time",
        message: "朝会の時刻（08:30）が勤務時間帯（09:00〜18:00）の外にあります",
      },
    ]);
  });

  it("帯 09:00-18:00・夕会 19:00 の警告の message は受入基準の文面である", () => {
    expect(
      findMeetingTimeWarnings({ ...DEFAULTS, evening_meeting_time: "19:00" }),
    ).toEqual([
      {
        code: "meeting_outside_working_hours",
        key: "evening_meeting_time",
        message: "夕会の時刻（19:00）が勤務時間帯（09:00〜18:00）の外にあります",
      },
    ]);
  });

  it("帯の両端は入力の帯から組み立てる（既定の帯を文面に埋め込まない）", () => {
    const [warning] = findMeetingTimeWarnings({
      work_start: "07:00",
      work_end: "22:00",
      morning_meeting_time: "06:59",
      evening_meeting_time: "22:00",
    });
    expect(warning.message).toBe(
      "朝会の時刻（06:59）が勤務時間帯（07:00〜22:00）の外にあります",
    );
  });
});

// 解析できない時刻（書式は保存時に保証済みのため通常は来ない。万一来たとき
// 根拠の無い警告を出さない）。
describe("findMeetingTimeWarnings — 時刻を解析できない入力（#712）", () => {
  it.each([
    ["work_start", { work_start: "xx:yy" }],
    ["work_end", { work_end: "" }],
  ])("%s が解析できないとき、会が帯の外に見えても警告は 0 件である", (_name, patch) => {
    expect(
      findMeetingTimeWarnings({
        ...DEFAULTS,
        ...patch,
        morning_meeting_time: "03:00",
        evening_meeting_time: "23:00",
      }),
    ).toEqual([]);
  });

  it("朝会の時刻だけが解析できないとき、朝会は判定せず夕会は判定する", () => {
    expect(
      keysOf({ morning_meeting_time: "invalid", evening_meeting_time: "19:00" }),
    ).toEqual(["evening_meeting_time"]);
  });

  it("夕会の時刻だけが解析できないとき、夕会は判定せず朝会は判定する", () => {
    expect(
      keysOf({ morning_meeting_time: "08:00", evening_meeting_time: "invalid" }),
    ).toEqual(["morning_meeting_time"]);
  });
});
