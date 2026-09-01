import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReportApiError,
  fetchDailyReport,
  fetchDailyReportSummaries,
  generateDailyReport,
} from "./daily-reports-api";
import type { DailyReport, DailyReportSummary } from "./daily-report";

const SAMPLE_SUMMARY: DailyReportSummary = {
  date: "2026-08-14",
  created_at: "2026-08-14T10:30:00.000Z",
  updated_at: "2026-08-14T10:35:00.000Z",
};

const SAMPLE_REPORT: DailyReport = {
  ...SAMPLE_SUMMARY,
  id: 1,
  content: "# 日報 2026-08-14（金）\n",
  evening_session_id: 12,
};

describe("fetchDailyReportSummaries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed summary list when the request succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_SUMMARY]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summaries = await fetchDailyReportSummaries();

    expect(summaries).toEqual([SAMPLE_SUMMARY]);
    expect(fetchMock).toHaveBeenCalledWith("/api/reports");
  });

  it("throws a ReportApiError with the server-provided code on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "internal error" }),
      }),
    );

    await expect(fetchDailyReportSummaries()).rejects.toMatchObject({
      message: "internal error",
      code: undefined,
    });
  });
});

describe("fetchDailyReport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed report when the request succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_REPORT),
    });
    vi.stubGlobal("fetch", fetchMock);

    const report = await fetchDailyReport("2026-08-14");

    expect(report).toEqual(SAMPLE_REPORT);
    expect(fetchMock).toHaveBeenCalledWith("/api/reports/2026-08-14");
  });

  it("throws a ReportApiError carrying code 'report_not_found' on a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () =>
          Promise.resolve({
            error: "report for 2026-08-14 not found",
            code: "report_not_found",
          }),
      }),
    );

    const error = await fetchDailyReport("2026-08-14").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ReportApiError);
    expect((error as ReportApiError).code).toBe("report_not_found");
    expect((error as ReportApiError).message).toBe(
      "report for 2026-08-14 not found",
    );
  });
});

describe("generateDailyReport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the generate endpoint and returns the generated report", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_REPORT),
    });
    vi.stubGlobal("fetch", fetchMock);

    const report = await generateDailyReport();

    expect(report).toEqual(SAMPLE_REPORT);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/reports/generate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws a ReportApiError carrying code 'evening_session_required' on a 409", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            error: "夕会を完了すると日報を生成できます",
            code: "evening_session_required",
          }),
      }),
    );

    const error = await generateDailyReport().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ReportApiError);
    expect((error as ReportApiError).code).toBe("evening_session_required");
  });
});
