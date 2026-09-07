import { describe, expect, it } from "vitest";
import { isMentoringComplete } from "./mentoring-gate.js";

// #276 判断3: メンタリング完了の機械判定。DB を触らない純粋関数として、
// 2つの件数（kind='mentoring' の decisions 件数・role='user' の messages
// 件数）を受け取り、両方が1件以上のときのみ true を返す。片方だけでは
// 対話の強制にならない（記録だけ／発言だけでは完了扱いにしない）。
describe("isMentoringComplete", () => {
  it("returns true when there is at least one mentoring record and one user message", () => {
    expect(
      isMentoringComplete({ mentoringRecordCount: 1, userMessageCount: 1 }),
    ).toBe(true);
  });

  it("returns false when there is no mentoring record, even with user messages", () => {
    expect(
      isMentoringComplete({ mentoringRecordCount: 0, userMessageCount: 3 }),
    ).toBe(false);
  });

  it("returns false when there is a mentoring record but no user message", () => {
    expect(
      isMentoringComplete({ mentoringRecordCount: 2, userMessageCount: 0 }),
    ).toBe(false);
  });

  it("returns false when both counts are zero", () => {
    expect(
      isMentoringComplete({ mentoringRecordCount: 0, userMessageCount: 0 }),
    ).toBe(false);
  });
});
