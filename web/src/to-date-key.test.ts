import { describe, expect, it } from "vitest";
import { toDateKey } from "./to-date-key";

describe("toDateKey", () => {
  it("formats a date as YYYY-MM-DD using the local calendar day when timeZone is omitted", () => {
    // 23:30 のように時刻成分がある入力でも、ローカル暦日（年月日）をそのまま
    // 使う。toISOString() ベースの実装だと、実行環境の TZ が UTC より遅れて
    // いる場合（例 America/New_York）に UTC 側の日付へ繰り上がってずれて
    // しまう（`npm run test:tz` で検出）。
    expect(toDateKey(new Date(2026, 7, 14, 23, 30))).toBe("2026-08-14");
  });

  it("zero-pads single-digit months and days for a near-midnight local time", () => {
    // toISOString() ベースの実装だと、実行環境の TZ が UTC より進んでいる
    // 場合（例 Asia/Tokyo）に UTC 側の日付へ繰り下がってずれてしまう。
    expect(toDateKey(new Date(2026, 0, 5, 0, 30))).toBe("2026-01-05");
  });

  it("converts to the requested IANA timeZone's calendar day, independent of process TZ", () => {
    // 実行環境の TZ に依存せず固定の瞬間を作るため、この1ケースだけは
    // Date.UTC で瞬間（エポック）を明示的に指定する。
    // UTC 2026-08-14T23:30 は Asia/Tokyo（+09:00）では 2026-08-15 08:30 に
    // なり、UTC と Asia/Tokyo とで暦日をまたぐ瞬間になっている。
    // toISOString().slice(0, 10) ベースの実装は timeZone 引数を無視して常に
    // UTC の暦日を返すため、Asia/Tokyo 側のアサーションで
    // `TZ=UTC npm test` でも `npm run test:tz` でも必ず落ちる。
    const instant = new Date(Date.UTC(2026, 7, 14, 23, 30));
    expect(toDateKey(instant, "UTC")).toBe("2026-08-14");
    expect(toDateKey(instant, "Asia/Tokyo")).toBe("2026-08-15");
  });

  // 省略時（getFullYear 等ベース）と、timeZone に実行環境自身のタイムゾーンを
  // 明示した場合（Intl.DateTimeFormat ベース）は、実装が別経路であっても常に
  // 一致すべき契約を固定する。本番の呼び出し箇所は省略時の経路しか通らない
  // ため、この一致が無いと Intl 側の経路は本番同等の入力で無検証になる。
  // server 側（server/src/detection/time-utils.test.ts）にも同じ対を置いている。
  it("agrees with the no-argument result when given the process's own resolved time zone", () => {
    const date = new Date(2026, 7, 14, 23, 30);
    const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    expect(toDateKey(date, systemTimeZone)).toBe(toDateKey(date));
  });
});
