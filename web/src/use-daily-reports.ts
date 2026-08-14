import { useCallback, useEffect, useState } from "react";
import {
  ReportApiError,
  fetchDailyReport,
  fetchDailyReportSummaries,
  generateDailyReport,
} from "./daily-reports-api";
import { toDateKey } from "./to-date-key";
import type { DailyReport, DailyReportSummary } from "./daily-report";

export type DailyReportsLoadStatus = "loading" | "ready" | "error";

export interface UseDailyReportsResult {
  status: DailyReportsLoadStatus;
  summaries: DailyReportSummary[];
  /** 現在表示中の日付（ローカル日付キー）。初期値は当日。 */
  selectedDate: string;
  /** 表示中の日報本文。当日で未生成、または前提条件未達なら null。 */
  report: DailyReport | null;
  /** true の間は「夕会を完了すると日報を生成できます」を表示する
   * （当日の日報が未生成、または再生成が 409 で失敗した場合）。 */
  needsEveningSession: boolean;
  /** 過去日付を選択した際の取得失敗（前提条件未達以外の理由）。 */
  selectError: string | null;
  isRegenerating: boolean;
  regenerateError: string | null;
  selectDate: (date: string) => void;
  regenerate: () => Promise<void>;
}

function toSummary(report: DailyReport): DailyReportSummary {
  return {
    date: report.date,
    created_at: report.created_at,
    updated_at: report.updated_at,
  };
}

/** 一覧を新しい順（日付の降順）に保つ。再生成時の重複排除に使う。 */
function upsertSummary(
  summaries: DailyReportSummary[],
  updated: DailyReportSummary,
): DailyReportSummary[] {
  const withoutDate = summaries.filter((s) => s.date !== updated.date);
  return [updated, ...withoutDate].sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * 当日の日報一覧を初期表示でロードし、過去日付の選択・再生成のアクションを
 * 公開するフック。`useDecisions` の fetch-on-mount パターンを踏襲しつつ、
 * 当日の日報の 404（`report_not_found`）は「エラー」ではなく「夕会未完了」
 * の状態として扱う（Issue #110: `POST /generate` の 409 と同じ状態表示に
 * 合流させる。仕様の「code で分岐する」制約に従い、いずれも
 * `ReportApiError.code` で判定する）。
 */
export function useDailyReports(): UseDailyReportsResult {
  const [todayKey] = useState(() => toDateKey(new Date()));
  const [status, setStatus] = useState<DailyReportsLoadStatus>("loading");
  const [summaries, setSummaries] = useState<DailyReportSummary[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayKey);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [needsEveningSession, setNeedsEveningSession] = useState(false);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadToday = fetchDailyReport(todayKey).then(
      (fetchedReport) => ({ report: fetchedReport, needsEveningSession: false }),
      (error: unknown) => {
        if (error instanceof ReportApiError && error.code === "report_not_found") {
          return { report: null, needsEveningSession: true };
        }
        throw error;
      },
    );

    Promise.all([fetchDailyReportSummaries(), loadToday])
      .then(([fetchedSummaries, todayResult]) => {
        if (cancelled) {
          return;
        }
        setSummaries(fetchedSummaries);
        setReport(todayResult.report);
        setNeedsEveningSession(todayResult.needsEveningSession);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [todayKey]);

  const selectDate = useCallback(
    (date: string) => {
      setSelectedDate(date);
      setSelectError(null);
      fetchDailyReport(date)
        .then((fetchedReport) => {
          setReport(fetchedReport);
          setNeedsEveningSession(false);
        })
        .catch((error: unknown) => {
          if (
            error instanceof ReportApiError &&
            error.code === "report_not_found" &&
            date === todayKey
          ) {
            setReport(null);
            setNeedsEveningSession(true);
            return;
          }
          setReport(null);
          setSelectError(
            error instanceof Error ? error.message : "日報の取得に失敗しました",
          );
        });
    },
    [todayKey],
  );

  const regenerate = useCallback(async () => {
    setIsRegenerating(true);
    setRegenerateError(null);
    try {
      const generated = await generateDailyReport();
      setReport(generated);
      setNeedsEveningSession(false);
      setSelectError(null);
      setSelectedDate(generated.date);
      setSummaries((prev) => upsertSummary(prev, toSummary(generated)));
    } catch (error) {
      if (error instanceof ReportApiError && error.code === "evening_session_required") {
        setNeedsEveningSession(true);
        setReport(null);
      } else {
        setRegenerateError(
          error instanceof Error ? error.message : "日報の生成に失敗しました",
        );
      }
    } finally {
      setIsRegenerating(false);
    }
  }, []);

  return {
    status,
    summaries,
    selectedDate,
    report,
    needsEveningSession,
    selectError,
    isRegenerating,
    regenerateError,
    selectDate,
    regenerate,
  };
}
