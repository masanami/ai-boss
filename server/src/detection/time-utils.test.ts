import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clamp,
  diffInMinutes,
  isWithinWorkingHours,
  timeStringToMinutes,
  toDateKey,
  toLocalOffset,
} from "./time-utils.js";

describe("clamp", () => {
  it("returns the value unchanged when within range", () => {
    expect(clamp(50, 15, 120)).toBe(50);
  });

  it("clamps to the minimum when below range", () => {
    expect(clamp(5, 15, 120)).toBe(15);
  });

  it("clamps to the maximum when above range", () => {
    expect(clamp(200, 15, 120)).toBe(120);
  });
});

describe("diffInMinutes", () => {
  it("returns the number of minutes elapsed between two dates", () => {
    const earlier = new Date("2026-07-05T09:00:00");
    const later = new Date("2026-07-05T09:30:00");
    expect(diffInMinutes(later, earlier)).toBe(30);
  });
});

describe("timeStringToMinutes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("converts an HH:mm string to minutes since midnight", () => {
    expect(timeStringToMinutes("09:30")).toBe(570);
  });

  it.each(["", "9", "ab:cd", "09:5", "banana"])(
    "returns null and warns for a malformed time string (%j)",
    (input) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      expect(timeStringToMinutes(input)).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    },
  );

  it.each(["24:00", "09:60"])(
    "returns null and warns for an out-of-range time string (%j)",
    (input) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      expect(timeStringToMinutes(input)).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    },
  );
});

describe("isWithinWorkingHours", () => {
  const workingHours = { start: "09:00", end: "18:00" };

  it("returns true when now is inside the window", () => {
    const now = new Date("2026-07-05T12:00:00");
    expect(isWithinWorkingHours(now, workingHours)).toBe(true);
  });

  it("returns true at the exact start boundary", () => {
    const now = new Date("2026-07-05T09:00:00");
    expect(isWithinWorkingHours(now, workingHours)).toBe(true);
  });

  it("returns false at the exact end boundary (end is exclusive)", () => {
    const now = new Date("2026-07-05T18:00:00");
    expect(isWithinWorkingHours(now, workingHours)).toBe(false);
  });

  it("returns false before the start", () => {
    const now = new Date("2026-07-05T08:59:00");
    expect(isWithinWorkingHours(now, workingHours)).toBe(false);
  });

  it("returns false after the end", () => {
    const now = new Date("2026-07-05T18:01:00");
    expect(isWithinWorkingHours(now, workingHours)).toBe(false);
  });

  it("falls back to the default working hours (09:00-18:00) when the setting is malformed", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const inside = new Date("2026-07-05T12:00:00");
    const outside = new Date("2026-07-05T08:00:00");
    const malformed = { start: "banana", end: "18:00" };

    expect(isWithinWorkingHours(inside, malformed)).toBe(true);
    expect(isWithinWorkingHours(outside, malformed)).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("toDateKey", () => {
  it("formats a local date as YYYY-MM-DD", () => {
    const date = new Date(2026, 6, 5, 23, 30);
    expect(toDateKey(date)).toBe("2026-07-05");
  });

  it("zero-pads single-digit months and days", () => {
    const date = new Date(2026, 0, 2, 0, 0);
    expect(toDateKey(date)).toBe("2026-01-02");
  });

  // 以下は timeZone 引数（ADR 0007 決定6・#177）の契約を検証する。
  //
  // 最初の3ケースでは Date を `Date.UTC(...)` で組み立てた「絶対時刻
  // （instant）」にしており、toDateKey に渡す timeZone 引数が実行環境
  // （process の TZ）に関係なくその暦日を決めることを確認する。時刻成分を
  // 23:30・00:30 に取ることで、実装を `toISOString().slice(0, 10)`（＝常に
  // UTC 暦日を返す）へ差し替えると実行環境の TZ を問わず必ず期待値とズレる
  // （UTC のケースを除く）ようにしている。
  // 最後のケースのみ趣旨が異なり、instant ではなくローカル日時から Date を
  // 組み、timeZone 省略時の経路と明示時の経路が一致することを固定する
  // （後述のコメント参照）。
  describe("with an explicit timeZone", () => {
    it("uses the given IANA time zone's calendar day, not the process TZ", () => {
      // 2026-07-05T23:30:00Z は Asia/Tokyo（UTC+9, DST無し）では既に
      // 2026-07-06 08:30 ＝ 翌暦日
      const instant = new Date(Date.UTC(2026, 6, 5, 23, 30));

      expect(toDateKey(instant, "Asia/Tokyo")).toBe("2026-07-06");
      expect(toDateKey(instant, "UTC")).toBe("2026-07-05");
    });

    it("rolls back to the previous calendar day west of UTC", () => {
      // 2026-07-06T00:30:00Z は America/New_York（夏時間で UTC-4）では
      // まだ 2026-07-05 20:30 ＝ 前暦日
      const instant = new Date(Date.UTC(2026, 6, 6, 0, 30));

      expect(toDateKey(instant, "America/New_York")).toBe("2026-07-05");
      expect(toDateKey(instant, "UTC")).toBe("2026-07-06");
    });

    it("zero-pads single-digit months and days for a non-UTC time zone", () => {
      // 2026-01-01T20:30:00Z は Asia/Tokyo では 2026-01-02 05:30
      const instant = new Date(Date.UTC(2026, 0, 1, 20, 30));

      expect(toDateKey(instant, "Asia/Tokyo")).toBe("2026-01-02");
    });

    // timeZone 省略時（getFullYear 等ベース）と、timeZone に実行環境自身の
    // タイムゾーンを明示した場合（Intl.DateTimeFormat ベース）は、実装が
    // 完全に別経路であっても常に一致すべき契約を固定する。既存の呼び出し
    // 箇所は全て省略時の経路しか通らないため、この一致が無いと Intl 側の
    // 経路（timeZone 指定時）は本番のどこからも同値性を検証されない。
    it("agrees with the no-argument result when given the process's own resolved time zone", () => {
      const date = new Date(2026, 6, 5, 23, 30);
      const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      expect(toDateKey(date, systemTimeZone)).toBe(toDateKey(date));
    });
  });
});

// 実行環境のタイムゾーンに依存しない形で検証する（ADR 0007 決定 5 と同じ
// 精神をオフセットにも及ぼす）。期待値へ "+09:00" のような固定値を書かず、
// 形式と、`getTimezoneOffset()` との整合だけを見る。
describe("toLocalOffset", () => {
  // -0 を +0 へ畳む。UTC ではオフセットが 0 になり、符号の掛け算（および
  // getTimezoneOffset() の符号反転）から -0 が生じる。`toBe` は Object.is
  // 比較で -0 と +0 を別物として扱うため、正規化しないと UTC 環境でだけ
  // 落ちる（分の値としては同一であり、区別に意味は無い）。
  function normalizeZero(minutes: number): number {
    return minutes === 0 ? 0 : minutes;
  }

  it("formats the local UTC offset as ±HH:MM", () => {
    const date = new Date(2026, 8, 5, 14, 32);

    expect(toLocalOffset(date)).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  it("returns an offset whose sign and magnitude match getTimezoneOffset()", () => {
    const date = new Date(2026, 8, 5, 14, 32);
    // getTimezoneOffset() は「UTC からの遅れ」を分で返すため符号が逆になる
    const expectedMinutes = -date.getTimezoneOffset();

    const [, sign, hours, minutes] =
      /^([+-])(\d{2}):(\d{2})$/.exec(toLocalOffset(date)) ?? [];
    const actualMinutes =
      (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));

    expect(normalizeZero(actualMinutes)).toBe(normalizeZero(expectedMinutes));
  });
});
