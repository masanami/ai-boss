import { describe, expect, it } from "vitest";
import {
  RelayUsageLimitError,
  describeUsageLimitReached,
  usageLimitResetAt,
  type RelayUsageLimit,
} from "./relay-usage-limit.js";

/**
 * 上限到達の案内（機能仕様 docs/features/llm-relay-server.md 受入基準（S2）S2-G）。
 * 戻る時刻は固定の UTC 時刻と**明示した時間帯**で検査する（実行するプロセスの時間帯
 * `npm test`／`npm run test:tz` によらず同じ結果になる）。
 */

const utc = (iso: string) => new Date(iso);

describe("usageLimitResetAt（上限が戻る時刻。中継の期間キーの UTC 境界）", () => {
  it("daily: 現在時刻より後の最初の UTC 0 時（2026-10-01T14:59:59Z → 2026-10-02T00:00:00Z）", () => {
    expect(usageLimitResetAt(utc("2026-10-01T14:59:59Z"), "daily")).toEqual(utc("2026-10-02T00:00:00Z"));
  });

  it("daily: 境界ちょうど（2026-10-01T00:00:00Z）は次の境界（2026-10-02T00:00:00Z）", () => {
    expect(usageLimitResetAt(utc("2026-10-01T00:00:00Z"), "daily")).toEqual(utc("2026-10-02T00:00:00Z"));
  });

  it("daily: 境界の 1 ミリ秒前（23:59:59.999Z）は、その日の終わりの境界", () => {
    expect(usageLimitResetAt(utc("2026-10-01T23:59:59.999Z"), "daily")).toEqual(utc("2026-10-02T00:00:00Z"));
  });

  it("daily: 月末・年末をまたぐ（2026-12-31T23:00:00Z → 2027-01-01T00:00:00Z）", () => {
    expect(usageLimitResetAt(utc("2026-12-31T23:00:00Z"), "daily")).toEqual(utc("2027-01-01T00:00:00Z"));
  });

  it("monthly: 現在時刻より後の最初の UTC の暦月の 1 日 0 時（2026-10-31T23:59:59Z → 2026-11-01T00:00:00Z）", () => {
    expect(usageLimitResetAt(utc("2026-10-31T23:59:59Z"), "monthly")).toEqual(utc("2026-11-01T00:00:00Z"));
  });

  it("monthly: 年をまたぐ（2026-12-15T12:00:00Z → 2027-01-01T00:00:00Z）", () => {
    expect(usageLimitResetAt(utc("2026-12-15T12:00:00Z"), "monthly")).toEqual(utc("2027-01-01T00:00:00Z"));
  });

  it("monthly: 境界ちょうど（2026-10-01T00:00:00Z）は次の境界（2026-11-01T00:00:00Z）", () => {
    expect(usageLimitResetAt(utc("2026-10-01T00:00:00Z"), "monthly")).toEqual(utc("2026-11-01T00:00:00Z"));
  });

  it("unknown では null", () => {
    expect(usageLimitResetAt(utc("2026-10-01T14:59:59Z"), "unknown")).toBeNull();
  });
});

describe("describeUsageLimitReached（案内の文言・仮定 A18）", () => {
  const now = utc("2026-10-01T14:59:59Z");

  it("daily（Asia/Tokyo）は 1 日の上限の文言で、戻る時刻 10月2日 9:00 を含む", () => {
    expect(describeUsageLimitReached("daily", now, "Asia/Tokyo")).toBe(
      "1 日の利用の上限に達しました。10月2日 9:00に戻ります。",
    );
  });

  it("同じ現在時刻で America/Los_Angeles は 10月1日 17:00、UTC は 10月2日 0:00（同じ UTC の境界を指す）", () => {
    expect(describeUsageLimitReached("daily", now, "America/Los_Angeles")).toContain("10月1日 17:00");
    expect(describeUsageLimitReached("daily", now, "UTC")).toContain("10月2日 0:00");
  });

  it("monthly（Asia/Tokyo）は 1 か月の上限の文言で、11月1日 9:00 を含む", () => {
    expect(describeUsageLimitReached("monthly", utc("2026-10-31T23:59:59Z"), "Asia/Tokyo")).toBe(
      "1 か月の利用の上限に達しました。11月1日 9:00に戻ります。",
    );
  });

  it("分は 2 桁（0 埋め）で出す（半時間ずれの時間帯 Asia/Kolkata: 0:00Z → 5:30）", () => {
    expect(describeUsageLimitReached("daily", now, "Asia/Kolkata")).toContain("10月2日 5:30");
  });

  it("0 時は 24:00 ではなく 0:00（hourCycle h23）", () => {
    // 2026-10-01T14:59:59Z の翌 0 時 UTC を UTC 表示すると 0:00。
    expect(describeUsageLimitReached("daily", now, "UTC")).not.toContain("24:00");
  });

  it("unknown は時刻を含まない不明の上限の文言", () => {
    expect(describeUsageLimitReached("unknown", now, "Asia/Tokyo")).toBe("利用の上限に達しました。");
  });

  it("3 種の文言のいずれも `API キー`・`BYOK`・`プラン` を含まない（BYOK・上位プランを勧めない）", () => {
    const limits: RelayUsageLimit[] = ["daily", "monthly", "unknown"];
    for (const limit of limits) {
      for (const timeZone of ["Asia/Tokyo", "UTC", "America/Los_Angeles"]) {
        const text = describeUsageLimitReached(limit, now, timeZone);
        for (const forbidden of ["API キー", "BYOK", "プラン"]) {
          expect(text, `${limit}/${timeZone}`).not.toContain(forbidden);
        }
      }
    }
  });

  it("時間帯を省略すると端末の時間帯で整形する（Intl の既定の時間帯と一致）", () => {
    const local = new Intl.DateTimeFormat("ja-JP", {
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(utc("2026-10-02T00:00:00Z"));
    const part = (type: string) => local.find((p) => p.type === type)!.value;
    const expected = `${part("month")}月${part("day")}日 ${part("hour")}:${part("minute")}`;
    expect(describeUsageLimitReached("daily", now)).toContain(expected);
  });
});

describe("RelayUsageLimitError", () => {
  it("limit を持ち、message は固定の文言（応答の本文・トークン・モデル ID を含まない）", () => {
    for (const limit of ["daily", "monthly", "unknown"] as const) {
      const error = new RelayUsageLimitError(limit);
      expect(error.limit).toBe(limit);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("LLM relay usage limit exceeded");
      expect(String(error)).not.toContain("ai-boss-plan-default");
    }
  });
});
