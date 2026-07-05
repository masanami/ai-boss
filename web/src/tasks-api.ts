import type { NewTaskInput, Task, TaskPatchInput } from "./task";

const TASKS_URL = "/api/tasks";

async function toErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `request failed with status ${response.status}`;
  } catch {
    return `request failed with status ${response.status}`;
  }
}

/**
 * Fetches the full task list from the backend. Throws when the response is
 * not ok so callers can distinguish success from failure.
 */
export async function fetchTasks(): Promise<Task[]> {
  const response = await fetch(TASKS_URL);
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as Task[];
}

/**
 * Creates a new task from the given input. Throws with the server-provided
 * error message when validation fails (e.g. an empty title).
 */
export async function createTask(input: NewTaskInput): Promise<Task> {
  const response = await fetch(TASKS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as Task;
}

/**
 * Applies a partial update to the task with the given id and returns the
 * updated task. Throws with the server-provided error message on failure
 * (e.g. an unknown id or invalid field value).
 */
export async function patchTask(
  id: number,
  patch: TaskPatchInput,
): Promise<Task> {
  const response = await fetch(`${TASKS_URL}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as Task;
}
