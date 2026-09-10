import { describe, expect, it, vi } from "vitest";

// `isValidIsoDateOrDateTime` は TZ 非依存に「暦として実在するか」を判定するが、
// `parseDateKey` はローカル `Date` の往復で検証するため、**実行 TZ が丸ごと
// スキップした暦日**では両者の判定が割れる（`Pacific/Apia` は 2011-12-30 を
// スキップしたため、その TZ では前者が true でも後者は null を返す。
// `lib/iso-date.ts` の実装コメント参照）。
//
// この分岐は特定の TZ でしか再現しないため、`parseDateKey` を null に固定して
// 検証する。`due-at.ts` が非 null 断言でこれを潰すと
// `startOfNextLocalDayIso(null)` が TypeError で落ちるため、「締切なし」へ
// 倒すこと（ADR 0010 決定 6 と同じ倒し方）をここで担保する。
vi.mock("../detection/time-utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("../detection/time-utils.js")>(
      "../detection/time-utils.js",
    );
  return { ...actual, parseDateKey: () => null };
});

const { normalizeDueAtToDateKey, toDueAtInstant } = await import("./due-at.js");

describe("due_at whose local calendar day is unparseable in the running timezone", () => {
  it("toDueAtInstant falls back to null instead of throwing", () => {
    expect(() => toDueAtInstant("2011-12-30")).not.toThrow();
    expect(toDueAtInstant("2011-12-30")).toBeNull();
  });

  it("normalizeDueAtToDateKey falls back to null instead of throwing", () => {
    expect(() => normalizeDueAtToDateKey("2011-12-30")).not.toThrow();
    expect(normalizeDueAtToDateKey("2011-12-30")).toBeNull();
  });
});
