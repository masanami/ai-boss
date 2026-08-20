import { useCopyToClipboard } from "./use-copy-to-clipboard";
import { useWorkLog } from "./use-work-log";
import "./WorkLogView.css";

/**
 * 管理者共有向け作業ログのビュー（Issue #161・保証 G-170-145〜G-170-147）。
 * 日付を選ぶとサーバーが都度生成した作業ログを表示し、コピー
 * できる。保存が無く常に最新データから生成されるため「再生成」ボタンは
 * 置かない。
 */
function WorkLogView() {
  const { selectedDate, workLog, error, selectDate } = useWorkLog();
  const { copyState, copy, textareaRef } = useCopyToClipboard(
    workLog?.content ?? null,
  );

  return (
    <div className="work-log-view">
      <div className="work-log-actions">
        <label className="work-log-date-label">
          対象日
          <input
            type="date"
            value={selectedDate}
            onChange={(event) => {
              // date input はクリア操作で空文字を送ってくる。空はローカル
              // 日付キーとして無効なので選択を変更しない。
              if (event.target.value !== "") {
                selectDate(event.target.value);
              }
            }}
          />
        </label>
        <button type="button" onClick={copy} disabled={workLog === null}>
          コピー
        </button>
      </div>

      {error !== null && <p role="alert">{error}</p>}
      {copyState.kind === "success" && <p role="status">コピーしました</p>}
      {copyState.kind === "failure" && (
        <>
          <p role="alert">
            コピーに失敗しました。下のテキスト領域から手動でコピーしてください
          </p>
          {workLog !== null && (
            <textarea
              ref={textareaRef}
              className="work-log-fallback-textarea"
              aria-label="作業ログ本文（手動コピー用）"
              readOnly
              value={workLog.content}
            />
          )}
        </>
      )}

      {workLog === null && error === null && (
        <p className="work-log-status">作業ログを読み込み中…</p>
      )}
      {workLog !== null && (
        <pre
          className="work-log-content"
          role="document"
          aria-label="作業ログ本文"
        >
          {workLog.content}
        </pre>
      )}
    </div>
  );
}

export default WorkLogView;
