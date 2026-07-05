import { useState } from "react";
import type { FormEvent } from "react";
import type { NewTaskInput, TaskPriority } from "./task";

interface TaskFormProps {
  /** Resolves to true when the task was created; the form only clears then. */
  onCreate: (input: NewTaskInput) => Promise<boolean>;
}

function TaskForm({ onCreate }: TaskFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority | "">("");
  const [dueAt, setDueAt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting || title.trim() === "") {
      return;
    }

    setIsSubmitting(true);
    void onCreate({
      title: title.trim(),
      description: description.trim() === "" ? null : description.trim(),
      priority: priority === "" ? null : priority,
      due_at: dueAt === "" ? null : dueAt,
    })
      .then((created) => {
        if (!created) {
          return;
        }
        setTitle("");
        setDescription("");
        setPriority("");
        setDueAt("");
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  };

  return (
    <form className="task-form" aria-label="タスク作成" onSubmit={handleSubmit}>
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
      <button type="submit" disabled={isSubmitting}>
        追加
      </button>
    </form>
  );
}

export default TaskForm;
