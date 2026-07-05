import { afterEach, describe, expect, it, vi } from "vitest";
import { createTask, fetchTasks, patchTask } from "./tasks-api";
import type { Task } from "./task";

const SAMPLE_TASK: Task = {
  id: 1,
  title: "資料を作る",
  description: null,
  category: "work",
  priority: null,
  due_at: null,
  status: "todo",
  boss_comment: null,
  estimated_minutes: null,
  created_at: "2026-07-05T00:00:00.000Z",
  updated_at: "2026-07-05T00:00:00.000Z",
  completed_at: null,
};

describe("fetchTasks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed task list when the request succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([SAMPLE_TASK]),
      }),
    );

    const tasks = await fetchTasks();

    expect(tasks).toEqual([SAMPLE_TASK]);
  });

  it("throws with the server error message when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "internal error" }),
      }),
    );

    await expect(fetchTasks()).rejects.toThrow("internal error");
  });
});

describe("createTask", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the input and returns the created task", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(SAMPLE_TASK),
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await createTask({ title: "資料を作る" });

    expect(created).toEqual(SAMPLE_TASK);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "資料を作る" }),
      }),
    );
  });

  it("throws with the server error message when creation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({ error: "title is required and must not be empty" }),
      }),
    );

    await expect(createTask({ title: "" })).rejects.toThrow(
      "title is required and must not be empty",
    );
  });
});

describe("patchTask", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("patches the task by id and returns the updated task", async () => {
    const updated = { ...SAMPLE_TASK, status: "in_progress" as const };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(updated),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await patchTask(1, { status: "in_progress" });

    expect(result).toEqual(updated);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "in_progress" }),
      }),
    );
  });

  it("throws with the server error message when the patch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "task 1 not found" }),
      }),
    );

    await expect(patchTask(1, { status: "done" })).rejects.toThrow(
      "task 1 not found",
    );
  });
});
