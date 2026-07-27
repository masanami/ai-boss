import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTask as createTaskRequest,
  fetchTasks,
  patchTask,
} from "./tasks-api";
import type { NewTaskInput, Task, TaskPatchInput } from "./task";

export type TasksLoadStatus = "loading" | "ready" | "error";

export interface UseTasksResult {
  tasks: Task[];
  status: TasksLoadStatus;
  addTask: (input: NewTaskInput) => Promise<void>;
  editTask: (id: number, patch: TaskPatchInput) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Loads the task list on mount and exposes actions to create tasks and
 * apply partial updates (e.g. status changes, edits). Mirrors the
 * fetch-on-mount pattern used by `useHealthCheck`.
 */
export function useTasks(): UseTasksResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<TasksLoadStatus>("loading");
  // refresh が並行したとき、先行リクエストの遅延レスポンスが最新の結果を
  // 巻き戻さないよう、世代番号で最新リクエストの応答だけを反映する。
  const generationRef = useRef(0);

  // 一覧の再取得。読み込み済みの表示を消してちらつかせないよう、
  // status は成功/失敗の結果だけ更新する（loading には戻さない）。
  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const next = await fetchTasks();
      if (generation !== generationRef.current) {
        return;
      }
      setTasks(next);
      setStatus("ready");
    } catch {
      if (generation !== generationRef.current) {
        return;
      }
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addTask = useCallback(async (input: NewTaskInput) => {
    const created = await createTaskRequest(input);
    setTasks((prev) => [...prev, created]);
  }, []);

  const editTask = useCallback(async (id: number, patch: TaskPatchInput) => {
    const updated = await patchTask(id, patch);
    setTasks((prev) => prev.map((task) => (task.id === id ? updated : task)));
  }, []);

  return { tasks, status, addTask, editTask, refresh };
}
