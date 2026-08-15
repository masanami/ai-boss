import { useEffect, useRef, useState } from "react";
import { useDailyReports } from "./use-daily-reports";
import "./DailyReportView.css";

type CopyState = { kind: "idle" } | { kind: "success" } | { kind: "failure" };

const HINT_MESSAGE = "夕会を完了すると日報を生成できます";

function DailyReportView() {
  const {
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
  } = useDailyReports();

  const [copyState, setCopyState] = useState<CopyState>({ kind: "idle" });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 表示中の本文が変わったら（日付切り替え・再生成）、直前のコピー結果表示は
  // 古い本文についてのものなので消す。
  useEffect(() => {
    setCopyState({ kind: "idle" });
  }, [report?.content]);

  useEffect(() => {
    if (copyState.kind === "failure" && textareaRef.current) {
      textareaRef.current.select();
    }
  }, [copyState]);

  const handleCopy = () => {
    if (report === null) {
      return;
    }
    // 非セキュアコンテキストでは navigator.clipboard 自体が undefined で、
    // .writeText を呼ぶと同期的に TypeError が投げられる（.then の失敗
    // ハンドラには届かない）。try/catch で同期例外も失敗扱いに落とす。
    try {
      if (!navigator.clipboard) {
        throw new Error("clipboard API is unavailable");
      }
      navigator.clipboard.writeText(report.content).then(
        () => setCopyState({ kind: "success" }),
        () => setCopyState({ kind: "failure" }),
      );
    } catch {
      setCopyState({ kind: "failure" });
    }
  };

  if (status === "loading") {
    return (
      <p className="daily-report-status">日報を読み込み中…</p>
    );
  }
  if (status === "error") {
    return (
      <p className="daily-report-status" role="alert">
        日報の取得に失敗しました
      </p>
    );
  }

  return (
    <div className="daily-report-view">
      <div className="daily-report-layout">
        <aside className="daily-report-history" aria-label="過去日報一覧">
          <h3>過去の日報</h3>
          {summaries.length === 0 ? (
            <p>まだ日報はありません</p>
          ) : (
            <ul className="daily-report-history-list" aria-label="過去の日報">
              {summaries.map((summary) => (
                <li key={summary.date}>
                  <button
                    type="button"
                    aria-pressed={summary.date === selectedDate}
                    onClick={() => selectDate(summary.date)}
                  >
                    {summary.date}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="daily-report-main">
          <div className="daily-report-actions">
            <button
              type="button"
              onClick={() => {
                void regenerate();
              }}
              disabled={isRegenerating}
            >
              {isRegenerating ? "生成中…" : "再生成"}
            </button>
            <button
              type="button"
              onClick={handleCopy}
              disabled={report === null}
            >
              コピー
            </button>
          </div>

          {regenerateError !== null && <p role="alert">{regenerateError}</p>}
          {selectError !== null && <p role="alert">{selectError}</p>}
          {copyState.kind === "success" && (
            <p role="status">コピーしました</p>
          )}
          {copyState.kind === "failure" && (
            <>
              <p role="alert">
                コピーに失敗しました。下のテキスト領域から手動でコピーしてください
              </p>
              {report !== null && (
                <textarea
                  ref={textareaRef}
                  className="daily-report-fallback-textarea"
                  aria-label="日報本文（手動コピー用）"
                  readOnly
                  value={report.content}
                />
              )}
            </>
          )}

          {needsEveningSession && (
            <p className="daily-report-hint">{HINT_MESSAGE}</p>
          )}
          {report !== null && (
            <pre
              className="daily-report-content"
              role="document"
              aria-label="日報本文"
            >
              {report.content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export default DailyReportView;
