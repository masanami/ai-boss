import { useEffect, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";
import { TASK_STATUSES } from "./task";
import type { Task, TaskPatchInput, TaskPriority, TaskStatus } from "./task";
import { TASK_DRAG_DATA_TYPE } from "./task-dnd";
import type { TaskEvidence } from "./task-evidence";
import {
  addFileEvidence,
  addLinkEvidence,
  deleteTaskEvidence,
  describeTasksApiError,
  evidenceContentUrl,
  fetchTaskEvidences,
} from "./tasks-api";

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

type EvidenceListStatus = "idle" | "loading" | "ready" | "error";

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

  // タスク詳細（編集 UI）のエビデンス一覧・追加・削除（AC-67〜71）。
  const [evidences, setEvidences] = useState<TaskEvidence[]>([]);
  const [evidencesStatus, setEvidencesStatus] =
    useState<EvidenceListStatus>("idle");
  const [linkUrl, setLinkUrl] = useState("");
  const [evidenceActionError, setEvidenceActionError] = useState<
    string | null
  >(null);

  // 編集モードに入っている間だけ、当該タスクのエビデンス一覧を取得する
  // （タスク一覧の各行が常時取得すると N+1 になるため）。
  useEffect(() => {
    if (!isEditing) {
      return;
    }
    let cancelled = false;
    setEvidencesStatus("loading");
    fetchTaskEvidences(task.id)
      .then((list) => {
        if (cancelled) {
          return;
        }
        setEvidences(list);
        setEvidencesStatus("ready");
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setEvidencesStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [isEditing, task.id]);

  const startEditing = () => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setPriority(task.priority ?? "");
    setDueAt(toDateInputValue(task.due_at));
    setEvidenceRequired(task.evidence_required);
    setLinkUrl("");
    setEvidenceActionError(null);
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
    setEvidenceActionError(null);
    addFileEvidence(task.id, file)
      .then((created) => {
        setEvidences((prev) => [...prev, created]);
      })
      .catch((error: unknown) => {
        setEvidenceActionError(
          describeTasksApiError(error, "エビデンスの追加に失敗しました"),
        );
      });
  };

  const handleAddLink = () => {
    const url = linkUrl.trim();
    if (url === "") {
      return;
    }
    setEvidenceActionError(null);
    addLinkEvidence(task.id, url)
      .then((created) => {
        setEvidences((prev) => [...prev, created]);
        setLinkUrl("");
      })
      .catch((error: unknown) => {
        setEvidenceActionError(
          describeTasksApiError(error, "エビデンスの追加に失敗しました"),
        );
      });
  };

  const handleDeleteEvidence = (evidenceId: number) => {
    setEvidenceActionError(null);
    deleteTaskEvidence(task.id, evidenceId)
      .then(() => {
        setEvidences((prev) => prev.filter((item) => item.id !== evidenceId));
      })
      .catch((error: unknown) => {
        setEvidenceActionError(
          describeTasksApiError(error, "エビデンスの削除に失敗しました"),
        );
      });
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
                      href={evidenceContentUrl(task.id, evidence.id)}
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
            <input type="file" onChange={handleFileSelected} />
          </label>
          <label>
            エビデンスURL
            <input
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
            />
          </label>
          <button type="button" onClick={handleAddLink}>
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
      </div>
    </div>
  );
}

export default TaskCard;
