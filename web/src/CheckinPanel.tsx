import { useEffect, useMemo, useState } from "react";
import { selectDefaultTask } from "./select-default-task";
import { useCheckinPanel } from "./use-checkin-panel";
import { buildOccurredAtIso, isFutureIso } from "./build-occurred-at-iso";
import type { ActivityEvent, CheckinInput } from "./activity-event";
import type { UseTasksResult } from "./use-tasks";
import "./CheckinPanel.css";

/**
 * 一言添える再生成注記（#243 判断3・仮定4）。時刻指定の記録では常時表示する。
 */
const REPORT_REGENERATION_NOTE = "（日報を生成済みなら再生成が必要です）";

const BREAK_PRESET_MINUTES = [5, 15, 30] as const;
const DEFAULT_BREAK_MINUTES = 15;

const EVENT_TYPE_LABEL: Record<ActivityEvent["type"], string> = {
  task_start: "着手",
  break_start: "休憩開始",
  break_end: "戻り",
  checkin: "チェックイン",
  chat_message: "チャット発言",
  task_update: "タスク操作",
  task_pause: "一時停止",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface CheckinPanelProps {
  /** AppLayout にリフトアップされた共有 tasksState（Issue #70）。tasks は
   * タスクボードの作成・ステータス変更がリロードなしで「着手するタスク」に
   * 反映されるのに使い、refresh はチェックイン成功時にタスクボード側の
   * ステータス変化（例: task_start による todo → in_progress、Issue #133）
   * を即時反映するために使う（Issue #134）。editTask は「完了」ボタン
   * （Issue #138）が選択中タスクを status: "done" にするために使う。
   * addTask は現状未使用だが、TaskBoard（Issue #70）と同じ「共有
   * tasksState を丸ごと受け取る」パターンに揃えている。 */
  tasksState: UseTasksResult;
}

function CheckinPanel({ tasksState }: CheckinPanelProps) {
  const { tasks, refresh, editTask } = tasksState;
  const {
    events,
    status,
    isOnBreak,
    submitError,
    isSubmitting,
    submitCheckin,
    submitCheckins,
    clearSubmitError,
    completeTask,
  } = useCheckinPanel(refresh);

  const selectableTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.status === "todo" ||
          task.status === "in_progress" ||
          task.status === "paused",
      ),
    [tasks],
  );
  const defaultTask = useMemo(
    () => selectDefaultTask(selectableTasks),
    [selectableTasks],
  );

  const [selectedTaskId, setSelectedTaskId] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [breakPreset, setBreakPreset] = useState<string>(
    String(DEFAULT_BREAK_MINUTES),
  );
  const [customMinutes, setCustomMinutes] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  // 「時刻を指定して記録」の展開式トグル（#243 判断0・画面設計）。折りたたみ時
  // (timeExpanded === false) は既存の操作・見た目を一切変えない（AC-30）。
  const [timeExpanded, setTimeExpanded] = useState(false);
  const [recordTime, setRecordTime] = useState("");
  const [returnTime, setReturnTime] = useState("");
  // 判断6 の直列送信で break_start だけが記録され break_end が失敗した状態
  // （Codex 指摘 PR #354）。この状態を isOnBreak（活動一覧からの導出）とは
  // 独立に保持する: 後追いする休憩より後に閉じた休憩が既にあると isOnBreak
  // は false のままで「戻りました」が出ず、「休憩」を押し直すと break_start が
  // 二重に記録されてしまう。pending の間は「休憩」が break_end だけを再送する。
  // 保留中の休憩の時刻（HH:mm）は展開欄の入力とは独立に保持する（Codex 指摘
  // PR #356/#357: 展開欄を折りたたむと recordIso / returnIso が null になり、
  // 保留フラグだけが残ると「休憩」が新しい break_start を二重記録し、
  // 「戻りました」が現在時刻で break_end を記録してしまう）。
  const [pendingBreak, setPendingBreak] = useState<{
    startTime: string;
    returnTime: string;
  } | null>(null);

  useEffect(() => {
    // 未選択のときはデフォルトタスクを設定する。選択中タスクが完了などで
    // selectableTasks から外れた場合も、<select> の表示と state の食い違い
    // （存在しない task_id での送信）を防ぐためデフォルトへ戻す。
    const selectionValid =
      selectedTaskId !== "" &&
      selectableTasks.some((task) => task.id === selectedTaskId);
    if (!selectionValid) {
      setSelectedTaskId(defaultTask?.id ?? "");
    }
  }, [defaultTask, selectableTasks, selectedTaskId]);

  const taskTitleById = useMemo(() => {
    const map = new Map<number, string>();
    tasks.forEach((task) => map.set(task.id, task.title));
    return map;
  }, [tasks]);

  const noteOrNull = (): string | null =>
    note.trim() === "" ? null : note.trim();

  const runSubmit = (
    input: CheckinInput,
    successMessage: string,
    onSuccess?: () => void,
  ) => {
    setFeedback(null);
    void submitCheckin(input).then((ok) => {
      if (ok) {
        setNote("");
        setFeedback(successMessage);
        onSuccess?.();
      }
    });
  };

  const selectedTask = useMemo(
    () => selectableTasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectableTasks, selectedTaskId],
  );
  const hasInProgressTask = useMemo(
    () => selectableTasks.some((task) => task.status === "in_progress"),
    [selectableTasks],
  );

  // 時刻指定欄が展開され、かつ値が入っているときだけ occurred_at を組み立てる
  // （AC-26: 折りたたみ時・空値のときは常に null → 送信に occurred_at が
  // 付かない）。戻り時刻は isOnBreak の状態に関わらず算出する（セルフレビュー
  // 指摘: break_start 成功 → break_end 失敗 → isOnBreak=true へ切り替わった
  // 後も、機能仕様 判断6「保持された戻り時刻のまま『戻りました』で break_end
  // だけを再送できる」を成立させるには、戻り時刻の値と入力欄自体を isOnBreak
  // 遷移後も保持・表示し続ける必要があるため）。
  const recordIso =
    timeExpanded && recordTime !== "" ? buildOccurredAtIso(recordTime) : null;
  const returnIso =
    timeExpanded && returnTime !== "" ? buildOccurredAtIso(returnTime) : null;

  const recordTimeIsFuture = recordIso !== null && isFutureIso(recordIso);

  // 休憩ボタン専用の事前チェック（#243 判断6）。戻り時刻を入れているのに
  // 開始時刻が無い／戻り時刻が開始時刻以前、のいずれかなら 1 回も POST
  // せず休憩ボタンを無効化する（AC-21）。「戻り時刻が空でない場合の順序
  // チェック」は !isOnBreak（休憩ボタン）のときだけ意味を持つため
  // isOnBreak でガードする。
  let breakTimeInputError: string | null = null;
  if (!isOnBreak && returnIso !== null) {
    if (recordIso === null) {
      breakTimeInputError = "戻り時刻を記録するには記録する時刻も入力してください";
    } else if (returnIso <= recordIso) {
      breakTimeInputError = "戻り時刻は記録する時刻より後にしてください";
    }
  }
  // 戻り時刻の未来判定（AC-22）は isOnBreak の状態に関わらず表示する。
  // 戻り時刻は on-break でも「戻りました」の再送に使われる（判断6）ため、
  // isOnBreak でガードすると、そこでの無効化には理由が一切表示されない
  // 行き止まりになってしまう（セルフレビュー2周目の指摘）。
  if (returnIso !== null && isFutureIso(returnIso)) {
    breakTimeInputError = "戻り時刻を未来にはできません";
  }
  const breakDisabledByTimeInput = breakTimeInputError !== null;
  const recordTimeError = recordTimeIsFuture
    ? "記録する時刻を未来にはできません"
    : null;
  const timeInputError = recordTimeError ?? breakTimeInputError;

  // 「戻りました」（isOnBreak 時の break_end）の occurred_at は、戻り時刻が
  // 入っていればそれを優先し（休憩の開始＋戻りを直列送信した後、2 回目
  // だけが失敗した際の再送はこの経路を通る）、無ければ「記録する時刻」を
  // フォールバックとして使う（AC-25: 戻り時刻を使わず記録する時刻だけで
  // 戻りましたを送るケースをそのまま維持する）。
  // 保留中の再送に使う戻り時刻: 展開欄に戻り時刻が入っていれば（ユーザーが
  // 直した値を優先して）それ、無ければ保留時に控えた戻り時刻。
  const pendingReturnTime =
    pendingBreak === null
      ? null
      : timeExpanded && returnTime !== ""
        ? returnTime
        : pendingBreak.returnTime;
  const pendingReturnIso =
    pendingReturnTime === null ? null : buildOccurredAtIso(pendingReturnTime);
  const breakEndIso = returnIso ?? recordIso ?? pendingReturnIso;
  const breakEndTimeIsFuture =
    breakEndIso !== null && isFutureIso(breakEndIso);

  /** 再取得した活動一覧に、指定時刻の break_end が既に記録されているか
   * （応答が失われた break_end の突き合わせ。Codex 指摘 PR #356/#357）。 */
  const hasBreakEndAt = (
    refreshed: ActivityEvent[] | null,
    iso: string,
  ): boolean =>
    refreshed?.some(
      (event) => event.type === "break_end" && event.created_at === iso,
    ) ?? false;

  /** occurred_at 付き送信の成功メッセージを組み立てる（#243 判断3・仮定4）。 */
  const withTimeNote = (verb: string, timeLabel: string): string =>
    `${timeLabel}に${verb}しました${REPORT_REGENERATION_NOTE}`;

  // 「ひとこと」欄は着手/休憩/戻りと異なり完了操作では送信・クリアしない
  // （決定済みの仕様: PATCH /api/tasks/:id は note を受け付けないため）。
  const handleComplete = () => {
    if (selectedTaskId === "") {
      return;
    }
    const taskId = selectedTaskId;
    setFeedback(null);
    void completeTask(taskId, editTask).then((ok) => {
      if (ok) {
        setFeedback("完了しました");
      }
    });
  };

  const handleStart = () => {
    if (selectedTaskId === "" || recordTimeIsFuture) {
      return;
    }
    // 選択中タスクが paused でもラベルが「再開」に変わるだけで、送信内容は
    // task_start のまま変えない（親要件 #179 判断3）。
    const label = selectedTask?.status === "paused" ? "再開" : "着手";
    runSubmit(
      {
        type: "task_start",
        task_id: selectedTaskId,
        note: noteOrNull(),
        occurred_at: recordIso ?? undefined,
      },
      recordIso !== null
        ? withTimeNote(label, recordTime)
        : `${label}しました`,
    );
  };

  const handlePause = () => {
    if (selectedTaskId === "" || recordTimeIsFuture) {
      return;
    }
    runSubmit(
      {
        type: "task_pause",
        task_id: selectedTaskId,
        note: noteOrNull(),
        occurred_at: recordIso ?? undefined,
      },
      recordIso !== null ? withTimeNote("一時停止", recordTime) : "一時停止しました",
    );
  };

  const resolvedBreakMinutes =
    breakPreset === "custom" ? Number(customMinutes) : Number(breakPreset);
  const isBreakMinutesValid =
    Number.isInteger(resolvedBreakMinutes) && resolvedBreakMinutes > 0;

  const handleBreakStart = () => {
    if (!isBreakMinutesValid || recordTimeIsFuture || breakDisabledByTimeInput) {
      return;
    }
    // 保留中（break_start は記録済みで break_end だけが未記録）の再送は、
    // 展開欄の状態（折りたたみ・空値）に関わらず returnIso の判定より前に
    // 処理し、break_end だけを送る（break_start を二重記録しない）。
    if (pendingBreak !== null && pendingReturnIso !== null) {
      if (isFutureIso(pendingReturnIso)) {
        return;
      }
      const retryReturnIso = pendingReturnIso;
      const retryStartTime = pendingBreak.startTime;
      const retryReturnTime = pendingReturnTime ?? pendingBreak.returnTime;
      setFeedback(null);
      void submitCheckins([
        { type: "break_end", note: noteOrNull(), occurred_at: retryReturnIso },
      ]).then(({ ok, events: refreshed }) => {
        if (ok || hasBreakEndAt(refreshed, retryReturnIso)) {
          clearSubmitError();
          setPendingBreak(null);
          setNote("");
          setFeedback(
            `${retryStartTime}〜${retryReturnTime}の休憩を記録しました${REPORT_REGENERATION_NOTE}`,
          );
        }
      });
      return;
    }
    if (returnIso === null) {
      // 戻り時刻が空: 従来どおり break_start を 1 回だけ送信する（AC-20）。
      runSubmit(
        {
          type: "break_start",
          expected_minutes: resolvedBreakMinutes,
          note: noteOrNull(),
          occurred_at: recordIso ?? undefined,
        },
        recordIso !== null
          ? withTimeNote("休憩を開始", recordTime)
          : "休憩を開始しました",
      );
      return;
    }
    // 戻り時刻あり（#243 判断6）: break_start → break_end を直列で 2 回送信
    // する。1 回目が失敗したら 2 回目は送らず、2 回目が失敗しても 1 回目
    // （break_start）は取り消さない（AC-23）。展開欄の入力値は成功・失敗の
    // いずれでもここではクリアしない（AC-24: 少なくとも失敗時は保持必須。
    // 成功時も破壊的変更を避けるため保持のまま据え置く＝軽微な判断）。
    // breakDisabledByTimeInput のガードにより、ここに到達する時点で
    // recordIso は必ず非 null（戻り時刻だけ入れて開始時刻が無い状態は
    // 事前チェックで弾かれている）。
    const startIso = recordIso as string;
    const endIso = returnIso;
    const startTime = recordTime;
    const endTime = returnTime;
    setFeedback(null);
    void submitCheckins([
      {
        type: "break_start",
        expected_minutes: resolvedBreakMinutes,
        note: noteOrNull(),
        occurred_at: startIso,
      },
      { type: "break_end", note: noteOrNull(), occurred_at: endIso },
    ]).then(({ posted, ok, events: refreshed }) => {
      // 2 件目の応答が失われた／解釈できなかった場合でも、再取得した一覧に
      // その時刻の break_end があれば記録は完了している（Codex 指摘）。
      if (ok || (posted === 1 && hasBreakEndAt(refreshed, endIso))) {
        clearSubmitError();
        setPendingBreak(null);
        setNote("");
        setFeedback(
          `${startTime}〜${endTime}の休憩を記録しました${REPORT_REGENERATION_NOTE}`,
        );
        return;
      }
      // break_start（1 件目）だけが 201 を受けて break_end が失敗した場合:
      // 時刻を控えて保留にする（展開欄を折りたたんでも再送に使える）。
      if (posted === 1) {
        setPendingBreak({ startTime, returnTime: endTime });
      }
    });
  };

  const handleBreakEnd = () => {
    if (breakEndTimeIsFuture) {
      return;
    }
    // 戻り時刻があればそれを優先する（判断6の直列送信で 2 回目〔break_end〕
    // だけが失敗したときの再送は、isOnBreak へ切り替わった後のこの経路を
    // 通り、保持された戻り時刻で break_end を送り直せる）。
    const occurredAtIso = breakEndIso;
    const timeLabel =
      returnIso !== null
        ? returnTime
        : recordIso !== null
          ? recordTime
          : (pendingReturnTime ?? "");
    runSubmit(
      {
        type: "break_end",
        note: noteOrNull(),
        occurred_at: occurredAtIso ?? undefined,
      },
      occurredAtIso !== null
        ? `${timeLabel}に戻りました${REPORT_REGENERATION_NOTE}`
        : "おかえりなさい",
      () => setPendingBreak(null),
    );
  };

  return (
    <section className="checkin-panel" aria-label="チェックイン">
      <h2>チェックイン</h2>
      <div className="checkin-time-input-toggle">
        <button
          type="button"
          aria-expanded={timeExpanded}
          onClick={() => setTimeExpanded((expanded) => !expanded)}
        >
          時刻を指定して記録
        </button>
      </div>
      {timeExpanded && (
        <div className="checkin-panel-group checkin-time-input-group">
          <label>
            記録する時刻
            <input
              type="time"
              aria-label="記録する時刻"
              value={recordTime}
              onChange={(event) => {
                setRecordTime(event.target.value);
                // 開始時刻を変えたら「記録済みの break_start」との対応が
                // 切れるため、pending は解除して次回は通常の 2 件送信に戻す。
                setPendingBreak(null);
              }}
            />
          </label>
          <label>
            戻り時刻（任意）
            <input
              type="time"
              aria-label="戻り時刻（任意）"
              value={returnTime}
              onChange={(event) => setReturnTime(event.target.value)}
            />
          </label>
          {timeInputError !== null && (
            <p className="checkin-time-input-error">{timeInputError}</p>
          )}
        </div>
      )}
      {pendingBreak !== null && (
        // 展開欄の外に置き、折りたたんでも保留中であることが見えるようにする。
        <p className="checkin-time-input-error">
          {pendingBreak.startTime}の休憩開始は記録済みです。「休憩」または「戻りました」で戻り時刻（{pendingReturnTime}）だけを再送します
        </p>
      )}
      {isOnBreak ? (
        <div className="checkin-panel-group">
          <button
            type="button"
            className="checkin-primary-button"
            onClick={handleBreakEnd}
            disabled={isSubmitting || breakEndTimeIsFuture}
          >
            戻りました
          </button>
        </div>
      ) : (
        <>
          <div className="checkin-panel-group">
            <label>
              着手するタスク
              <select
                value={selectedTaskId}
                onChange={(event) =>
                  setSelectedTaskId(
                    event.target.value === "" ? "" : Number(event.target.value),
                  )
                }
                disabled={selectableTasks.length === 0}
              >
                {selectableTasks.length === 0 && (
                  <option value="">タスクがありません</option>
                )}
                {selectableTasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={handleStart}
              disabled={
                selectedTaskId === "" ||
                isSubmitting ||
                selectedTask?.status === "in_progress" ||
                recordTimeIsFuture
              }
            >
              {selectedTask?.status === "paused" ? "再開" : "着手"}
            </button>
            {hasInProgressTask && (
              <button
                type="button"
                onClick={handleComplete}
                disabled={
                  selectedTaskId === "" ||
                  selectedTask?.status !== "in_progress" ||
                  isSubmitting
                }
              >
                完了
              </button>
            )}
            {selectedTask?.status === "in_progress" && (
              <button
                type="button"
                onClick={handlePause}
                disabled={isSubmitting || recordTimeIsFuture}
              >
                一時停止
              </button>
            )}
          </div>
          <div className="checkin-panel-group">
            <label>
              休憩時間
              <select
                value={breakPreset}
                onChange={(event) => setBreakPreset(event.target.value)}
              >
                {BREAK_PRESET_MINUTES.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes}分
                  </option>
                ))}
                <option value="custom">自由入力</option>
              </select>
            </label>
            {breakPreset === "custom" && (
              <input
                type="number"
                min={1}
                aria-label="休憩時間（分・自由入力）"
                value={customMinutes}
                onChange={(event) => setCustomMinutes(event.target.value)}
              />
            )}
            <button
              type="button"
              onClick={handleBreakStart}
              disabled={
                !isBreakMinutesValid ||
                isSubmitting ||
                recordTimeIsFuture ||
                breakDisabledByTimeInput
              }
            >
              休憩
            </button>
          </div>
        </>
      )}
      <label>
        ひとこと（任意）
        <input
          aria-label="ひとこと"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      {submitError !== null && <p role="alert">{submitError}</p>}
      {submitError === null && feedback !== null && (
        <p className="checkin-feedback">{feedback}</p>
      )}
      <h3>今日の活動</h3>
      {status === "loading" && <p>読み込み中…</p>}
      {status === "error" && <p role="alert">活動の取得に失敗しました</p>}
      {status === "ready" && (
        <ul className="checkin-activity-list">
          {events.length === 0 && <li>まだ活動はありません</li>}
          {events.map((event) => (
            <li key={event.id}>
              <span>{formatTime(event.created_at)}</span>{" "}
              <span>{EVENT_TYPE_LABEL[event.type]}</span>{" "}
              {event.task_id !== null && (
                <span>
                  {taskTitleById.get(event.task_id) ?? `タスク#${event.task_id}`}
                </span>
              )}
              {event.note !== null && event.note !== "" && (
                <span>{event.note}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default CheckinPanel;
