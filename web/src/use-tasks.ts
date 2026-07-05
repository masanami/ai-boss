import { useCallback, useEffect, useState } from "react";
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
}

/**
 * Loads the task list on mount and exposes actions to create tasks and
 * apply partial updates (e.g. status changes, edits). Mirrors the
 * fetch-on-mount pattern used by `useHealthCheck`.
 */
export function useTasks(): UseTasksResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<TasksLoadStatus>("loading");

  useEffect(() => {
    let cancelled = false;

    fetchTasks()
      .then((fetched) => {
        if (!cancelled) {
          setTasks(fetched);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const addTask = useCallback(async (input: NewTaskInput) => {
    const created = await createTaskRequest(input);
    setTasks((prev) => [...prev, created]);
  }, []);

  const editTask = useCallback(async (id: number, patch: TaskPatchInput) => {
    const updated = await patchTask(id, patch);
    setTasks((prev) => prev.map((task) => (task.id === id ? updated : task)));
  }, []);

  return { tasks, status, addTask, editTask };
}
