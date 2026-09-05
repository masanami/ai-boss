import { afterEach, describe, expect, it, vi } from "vitest";
import { startOfLocalDayIso, startOfNextLocalDayIso } from "./local-day.js";

describe("startOfLocalDayIso", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the local midnight of the day containing the given date", () => {
    const now = new Date(2026, 6, 5, 15, 30, 0);

    expect(startOfLocalDayIso(now)).toBe(new Date(2026, 6, 5, 0, 0, 0, 0).toISOString());
  });

  it("defaults to the local day containing the current time when no date is given", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 5, 9, 0, 0));

    expect(startOfLocalDayIso()).toBe(new Date(2026, 6, 5, 0, 0, 0, 0).toISOString());
  });

  it("stays within the same calendar month when given the first day of a month", () => {
    // startOfLocalDayIso は月をまたがない（対になる startOfNextLocalDayIso と
    // 違い、日を進めない）。`new Date(y, m, 0)` は前月末になる（`Date` の日は
    // 1始まり）ため、日を誤って -1 する退行は月初の入力でこそ「前月末」へ
    // 転落して顕在化する。この境界を月初の入力で固定する。
    const now = new Date(2026, 7, 1, 3, 0, 0);

    expect(startOfLocalDayIso(now)).toBe(new Date(2026, 7, 1, 0, 0, 0, 0).toISOString());
  });

  it("always lands on local midnight of the same calendar date, whatever time of day it is given", () => {
    // 「当該暦日の 00:00 ちょうど」であることを、時刻成分の異なる複数の入力で固定する。
    const probes = [
      new Date(2026, 2, 8, 0, 0, 0, 1),
      new Date(2026, 2, 8, 1, 30, 0),
      new Date(2026, 2, 8, 23, 59, 59, 999),
    ];

    for (const probe of probes) {
      const result = new Date(startOfLocalDayIso(probe));

      expect(result.getFullYear()).toBe(probe.getFullYear());
      expect(result.getMonth()).toBe(probe.getMonth());
      expect(result.getDate()).toBe(probe.getDate());
      expect(result.getHours()).toBe(0);
      expect(result.getMinutes()).toBe(0);
      expect(result.getSeconds()).toBe(0);
      expect(result.getMilliseconds()).toBe(0);
    }
  });
});

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
    // 更新（#305）: `startOfNextLocalDayIso` に TZ の注入点は無い（`Date` の
    // ローカルメソッド直読みで、時刻は呼び出し側プロセスの TZ にそのまま従う）。
    // したがってこの関数のローカル暦日境界の正しさは、テストへ TZ を注入する
    // （案B。`toDateKey(date, timeZone?)` 用のアプローチで、この関数には適用
    // できない）のではなく、プロセスの実行 TZ 自体を変えて同じテストを複数回
    // 実行する（案A・`npm run test:tz` が `TZ=America/New_York` で追加実行する）
    // ことで守る。
    //
    // 下記 probe のうち 2026-03-08（America/New_York の夏時間**開始**日・当日は
    // 23 時間）と 2026-11-01（同**終了**日・当日は 25 時間）は、`TZ=America/New_York`
    // 実行下でのみ「暦日 00:00 に固定秒数（86400000ms）を足す」形の退行
    // （`new Date(startOfLocalDayIso(date)).getTime() + 86400000` 等）を検出できる
    // ことを実測済み（一時的に退行を注入し、両日とも `getHours()`/`getDate()` の
    // 期待値と食い違って fail することを確認、直後に復元）。つまりこの退行は
    // 既定の `npm test`（DST を採用しない TZ で実行）単体では検出できないが、
    // `npm run test:tz`（`TZ=America/New_York`）を含めた実行では検出できる。
    // 残る limitation は「DST を採用しない TZ だけで実行した場合は検出できない」
    // 点そのもの——`test:tz` が既に America/New_York で担保している以上、
    // これは TZ を追加すれば解消する種類の欠落ではなく、非 DST TZ 実行に
    // 固有の限界として残る。
    const probes = [
      new Date(2026, 2, 8, 1, 30, 0),
      new Date(2026, 2, 8, 23, 59, 59, 999),
      new Date(2026, 10, 1, 1, 30, 0),
    ];

    for (const probe of probes) {
      const result = new Date(startOfNextLocalDayIso(probe));
      const expectedNextDay = new Date(probe.getFullYear(), probe.getMonth(), probe.getDate() + 1);

      expect(result.getFullYear()).toBe(expectedNextDay.getFullYear());
      expect(result.getMonth()).toBe(expectedNextDay.getMonth());
      expect(result.getDate()).toBe(expectedNextDay.getDate());
      expect(result.getHours()).toBe(0);
      expect(result.getMinutes()).toBe(0);
      expect(result.getSeconds()).toBe(0);
      expect(result.getMilliseconds()).toBe(0);
    }
  });
});
