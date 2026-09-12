import { useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent, KeyboardEvent } from "react";
import { TASK_STATUSES } from "./task";
import type { Task, TaskPatchInput, TaskPriority, TaskStatus } from "./task";
import { TASK_DRAG_DATA_TYPE } from "./task-dnd";
import type { TaskEvidence } from "./task-evidence";
import { useTaskEvidences } from "./use-task-evidences";

interface TaskCardProps {
  task: Task;
  onStatusChange: (id: number, status: TaskStatus) => void;
  /** Resolves to true when the update succeeded; edit mode only closes then. */
  onEdit: (id: number, patch: TaskPatchInput) => Promise<boolean>;
  /**
   * ドラッグ中のタスク id を親へ通知する（開始時に id・終了時に null）。
   * 親はこれでドロップ先ハイライトの要否を判定する（Issue #122 レビュー指摘）。
   */
  onDraggingChange?: (id: number | null) => void;
  /**
   * タスクカードからのメンタリング起動（Issue #470, 親 #444 決定1）。
   * `null`（または未指定）のときは「メンタリングする」ボタン自体を描画しない
   * — 呼び出し元（`AppLayout`）が朝会・夕会の会中はこれを渡さないことで
   * AC-2 を満たす。このコンポーネントは adhoc 判定に関与しない（判断は
   * 呼び出し元）。表示モードのアクション行にのみ置き、編集モードには置かない
   * （未保存の編集を抱えたまま画面が切り替わる論点を避けるため）。
   *
   * 引数はこのカードが表示しているタスクそのものである（Issue #489 / S1a
   * 決定9）。id だけを渡すと呼び出し元が id からタスクを引き直すことになり、
   * 引けなかったときの分岐（タイトルの欠けた発言）が形として残ってしまう。
   */
  onStartMentoring?: ((task: Task) => void) | null;
  /**
   * 「メンタリングする」を非活性にする（Issue #489 / S1a 決定8）。送信中
   * （`sending`）・セッション切替中（`switching`）に押せてしまい、発言だけが
   * `useChat` の多重送信ガードへ無音で捨てられる状態（#474）を塞ぐ。
   *
   * 会中の**非表示**（`onStartMentoring = null`）とは別の状態として扱う
   * — 「会だから出さない」と「いま送れないだけ」を同じ表現に潰さないため。
   * 非表示にしないのは、送信のたびにボタンが消えて戻る（レイアウトが動く）
   * のを避けるためで、チャット画面ヘッダの各ボタンの扱いと同じである。
   *
   * 未指定は「押せる」（既存の呼び出し箇所の挙動を変えない）。可否の判断は
   * このコンポーネントではなく呼び出し元（`AppLayout`）が持つ。
   */
  startMentoringDisabled?: boolean;
}

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "未着手",
  in_progress: "進行中",
  paused: "一時停止",
  done: "完了",
  dropped: "中止",
};

// due_at は yyyy-MM-dd を想定するが、ISO 日時（ボスの tool use 等の将来経路）
// が入っても date input が黙って空欄→null 保存しないよう日付部分に正規化する
function toDateInputValue(dueAt: string | null): string {
  return (dueAt ?? "").slice(0, 10);
}

/** エビデンス一覧の表示ラベル（決定 1-c-ii の画像・PDF がプレビュー、それ以外は
 * ダウンロードになる旨は個々のブラウザ挙動に委ねる。明示的な仮定9: 独自
 * ビューアは作らず、常に遷移させる）。 */
function evidenceLabel(evidence: TaskEvidence): string {
  return evidence.kind === "file"
    ? (evidence.original_filename ?? "")
    : (evidence.url ?? "");
}

function TaskCard({
  task,
  onStatusChange,
  onEdit,
  onDraggingChange,
  onStartMentoring,
  startMentoringDisabled = false,
}: TaskCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [priority, setPriority] = useState<TaskPriority | "">(
    task.priority ?? "",
  );
  const [dueAt, setDueAt] = useState(toDateInputValue(task.due_at));
  const [evidenceRequired, setEvidenceRequired] = useState(
    task.evidence_required,
  );

  const [linkUrl, setLinkUrl] = useState("");

  // タスク詳細（編集 UI）のエビデンス一覧・追加・削除（AC-67〜71）。IO は
  // フックが所有し、このコンポーネントは表示に徹する（この web/ の既存規約）。
  // 編集モードに入っている間だけ取得する（タスク一覧の各行が常時取得すると
  // N+1 になるため）。
  const {
    evidences,
    status: evidencesStatus,
    actionError: evidenceActionError,
    isMutating,
    addFile,
    addLink,
    remove: removeEvidence,
    contentUrl,
  } = useTaskEvidences(task.id, isEditing);

  const startEditing = () => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setPriority(task.priority ?? "");
    setDueAt(toDateInputValue(task.due_at));
    setEvidenceRequired(task.evidence_required);
    setLinkUrl("");
    setIsEditing(true);
  };

  // ドラッグ開始はカード本体からのみ許可する。select/button（ステータス変更
  // プルダウン・編集ボタン）からの操作を D&D に奪われないよう、そこから始まった
  // dragstart は preventDefault してキャンセルする（Issue #122）。
  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("select, button") !== null) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(TASK_DRAG_DATA_TYPE, String(task.id));
    event.dataTransfer.effectAllowed = "move";
    onDraggingChange?.(task.id);
  };

  // dragend はドロップ成功時も中断時（Esc・領域外へ離す）も必ず発火するため、
  // ドラッグ中状態の解除はここに集約する。
  const handleDragEnd = () => {
    onDraggingChange?.(null);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (title.trim() === "") {
      return;
    }
    const patch: TaskPatchInput = {
      title: title.trim(),
      description: description.trim() === "" ? null : description.trim(),
      priority: priority === "" ? null : priority,
      due_at: dueAt === "" ? null : dueAt,
    };
    // evidence_required はトグルされたときだけ送る（AC-71）。既存の title 等
    // だけを編集する既存フローの送信内容を変えないための軽微な判断。
    if (evidenceRequired !== task.evidence_required) {
      patch.evidence_required = evidenceRequired;
    }
    void onEdit(task.id, patch).then((updated) => {
      if (updated) {
        setIsEditing(false);
      }
    });
  };

  const handleFileSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 同じファイルを選び直しても change が再発火するようにリセットする。
    event.target.value = "";
    if (!file) {
      return;
    }
    void addFile(file);
  };

  const handleAddLink = () => {
    const url = linkUrl.trim();
    if (url === "") {
      return;
    }
    // 失敗時に入力を消さない（消すと再入力を強いる）。成功したときだけ空にする。
    void addLink(url).then((added) => {
      if (added) {
        setLinkUrl("");
      }
    });
  };

  // URL 入力はタスク編集フォーム（送信ボタン「保存」を持つ）の内側にあるため、
  // Enter を捕まえないと HTML の暗黙送信でタスク編集が保存され、編集モードが
  // 閉じて入力中の URL が捨てられる。Enter は「URLを追加」と同じ動作にする。
  const handleLinkUrlKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    handleAddLink();
  };

  const handleDeleteEvidence = (evidenceId: number) => {
    void removeEvidence(evidenceId);
  };

  if (isEditing) {
    return (
      <form
        className="task-card task-card-edit"
        aria-label="タスクを編集"
        onSubmit={handleSubmit}
      >
        <label>
          タイトル
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          説明
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          優先度
          <select
            value={priority}
            onChange={(event) =>
              setPriority(event.target.value as TaskPriority | "")
            }
          >
            <option value="">未設定</option>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
        </label>
        <label>
          締切
          <input
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </label>
        <label>
          エビデンスを必須にする
          <input
            type="checkbox"
            checked={evidenceRequired}
            onChange={(event) => setEvidenceRequired(event.target.checked)}
          />
        </label>

        <div className="task-card-evidences">
          <h4>エビデンス</h4>
          {evidencesStatus === "loading" && <p>読み込み中…</p>}
          {evidencesStatus === "error" && (
            <p role="alert">エビデンスの取得に失敗しました</p>
          )}
          {evidencesStatus === "ready" && (
            <ul>
              {evidences.length === 0 && <li>まだエビデンスはありません</li>}
              {evidences.map((evidence) => (
                <li key={evidence.id}>
                  {evidence.kind === "file" ? (
                    <a
                      href={contentUrl(evidence.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {evidenceLabel(evidence)}
                    </a>
                  ) : (
                    <a
                      href={evidence.url ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {evidenceLabel(evidence)}
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={isMutating}
                    onClick={() => handleDeleteEvidence(evidence.id)}
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label>
            エビデンスファイル
            <input
              type="file"
              disabled={isMutating}
              onChange={handleFileSelected}
            />
          </label>
          <label>
            エビデンスURL
            <input
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
              onKeyDown={handleLinkUrlKeyDown}
            />
          </label>
          <button type="button" disabled={isMutating} onClick={handleAddLink}>
            URLを追加
          </button>
          {evidenceActionError !== null && (
            <p role="alert">{evidenceActionError}</p>
          )}
        </div>

        <div className="task-card-actions">
          <button type="submit">保存</button>
          <button type="button" onClick={() => setIsEditing(false)}>
            キャンセル
          </button>
        </div>
      </form>
    );
  }

  return (
    <div
      className="task-card"
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <h3>{task.title}</h3>
      {task.description !== null && task.description !== "" && (
        <p>{task.description}</p>
      )}
      {task.priority !== null && (
        <p>ボス決定: 優先度 {PRIORITY_LABEL[task.priority]}</p>
      )}
      {task.due_at !== null && (
        <p>ボス決定: 締切 {toDateInputValue(task.due_at)}</p>
      )}
      {task.boss_comment !== null && <p>ボスコメント: {task.boss_comment}</p>}
      <label>
        ステータス
        <select
          value={task.status}
          onChange={(event) =>
            onStatusChange(task.id, event.target.value as TaskStatus)
          }
        >
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      </label>
      <div className="task-card-actions">
        <button type="button" onClick={startEditing}>
          編集
        </button>
        {onStartMentoring !== null && onStartMentoring !== undefined && (
          <button
            type="button"
            onClick={() => onStartMentoring(task)}
            disabled={startMentoringDisabled}
          >
            メンタリングする
          </button>
        )}
      </div>
    </div>
  );
}

export default TaskCard;
