import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWorkLog } from "./work-logs-api";
import { ReportApiError } from "./daily-reports-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWorkLog", () => {
  it("GETs /api/work-logs/:date and returns the work log", async () => {
    const workLog = {
      date: "2026-08-18",
      content: "# 作業ログ 2026-08-18（火）\n\n（記録なし）",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(workLog),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWorkLog("2026-08-18")).resolves.toEqual(workLog);
    expect(fetchMock).toHaveBeenCalledWith("/api/work-logs/2026-08-18");
  });

  it("throws a ReportApiError carrying the server's code on a 400 invalid_date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: "日付は YYYY-MM-DD 形式で指定してください",
            code: "invalid_date",
          }),
      }),
    );

    const error = await fetchWorkLog("not-a-date").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReportApiError);
    expect((error as ReportApiError).code).toBe("invalid_date");
  });

  it("throws a ReportApiError without a code when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("not json")),
      }),
    );

    const error = await fetchWorkLog("2026-08-18").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReportApiError);
    expect((error as ReportApiError).code).toBeUndefined();
  });
});
