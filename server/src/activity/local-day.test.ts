import { describe, expect, it } from "vitest";
import { startOfLocalDayIso, startOfNextLocalDayIso } from "./local-day.js";

describe("startOfNextLocalDayIso", () => {
  it("returns the local midnight of the day after the given date", () => {
    const now = new Date(2026, 6, 5, 15, 30, 0);

    expect(startOfNextLocalDayIso(now)).toBe(
      new Date(2026, 6, 6, 0, 0, 0, 0).toISOString(),
    );
  });

  it("is exactly one calendar day after startOfLocalDayIso for the same input", () => {
    const now = new Date(2026, 6, 5, 15, 30, 0);

    const start = new Date(startOfLocalDayIso(now));
    const nextStart = new Date(startOfNextLocalDayIso(now));

    expect(nextStart.getFullYear()).toBe(start.getFullYear());
    expect(nextStart.getMonth()).toBe(start.getMonth());
    expect(nextStart.getDate()).toBe(start.getDate() + 1);
  });

  it("rolls over into the next month when given the last day of a month", () => {
    const now = new Date(2026, 6, 31, 23, 0, 0);

    expect(startOfNextLocalDayIso(now)).toBe(
      new Date(2026, 7, 1, 0, 0, 0, 0).toISOString(),
    );
  });

  it("rolls over into the next year when given December 31st", () => {
    const now = new Date(2026, 11, 31, 12, 0, 0);

    expect(startOfNextLocalDayIso(now)).toBe(
      new Date(2027, 0, 1, 0, 0, 0, 0).toISOString(),
    );
  });

  it("always lands on local midnight of the next calendar date, whatever time of day it is given", () => {
    // 「翌暦日の 00:00 ちょうど」であることを、時刻成分の異なる複数の入力で固定する。
    //
    // 限界（誇張しないこと）: これは `date.getTime() + 86400000`（時刻成分を保つ形）
    // の退行は検出するが、`new Date(startOfLocalDayIso(date)).getTime() + 86400000`
    // のような「暦日の 00:00 に固定秒数を足す」形は**検出しない** — DST を採用しない
    // TZ（実行環境の Asia/Tokyo を含む）ではその実装も常に 00:00 へ着地するため。
    // 固定秒数加算そのものを禁じる契約は、TZ をテストへ注入できるようになるまで
    // テストでは担保できない（ADR 0007「既知の逸脱」#177）。
    const probes = [
      new Date(2026, 2, 8, 1, 30, 0),
      new Date(2026, 2, 8, 23, 59, 59, 999),
      new Date(2026, 9, 25, 2, 30, 0),
    ];

    for (const probe of probes) {
      const result = new Date(startOfNextLocalDayIso(probe));

      expect(result.getHours()).toBe(0);
      expect(result.getMinutes()).toBe(0);
      expect(result.getSeconds()).toBe(0);
      expect(result.getMilliseconds()).toBe(0);
      expect(result.getDate()).toBe(new Date(probe.getFullYear(), probe.getMonth(), probe.getDate() + 1).getDate());
    }
  });
});
