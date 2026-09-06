import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addFileEvidence,
  addLinkEvidence,
  createTask,
  deleteTaskEvidence,
  describeTasksApiError,
  EVIDENCE_REQUIRED_DISPLAY_MESSAGE,
  evidenceContentUrl,
  fetchTaskEvidences,
  fetchTasks,
  patchTask,
  TasksApiError,
} from "./tasks-api";
import type { Task } from "./task";
import type { TaskEvidence } from "./task-evidence";

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
  evidence_required: false,
};

describe("fetchTasks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed task list when the request succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_TASK]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tasks = await fetchTasks();

    expect(tasks).toEqual([SAMPLE_TASK]);
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks");
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

  it("rejects with a TasksApiError that keeps the response body's code (AC-75)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            error: "エビデンスが添付されていないため、このタスクを完了にできません",
            code: "evidence_required",
          }),
      }),
    );

    const error: unknown = await patchTask(1, { status: "done" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TasksApiError);
    expect((error as TasksApiError).code).toBe("evidence_required");
    expect((error as TasksApiError).message).toBe(
      "エビデンスが添付されていないため、このタスクを完了にできません",
    );
  });

  it("leaves code undefined when the response body doesn't include one (AC-75)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "internal error" }),
      }),
    );

    const error: unknown = await patchTask(1, { status: "done" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TasksApiError);
    expect((error as TasksApiError).code).toBeUndefined();
  });
});

describe("describeTasksApiError", () => {
  it("returns the fixed evidence-required message for code: evidence_required, regardless of the server's wording (AC-76)", () => {
    expect(
      describeTasksApiError(
        new TasksApiError("文言A", "evidence_required"),
        "フォールバック",
      ),
    ).toBe(EVIDENCE_REQUIRED_DISPLAY_MESSAGE);
    expect(
      describeTasksApiError(
        new TasksApiError("まったく違う文言B", "evidence_required"),
        "フォールバック",
      ),
    ).toBe(EVIDENCE_REQUIRED_DISPLAY_MESSAGE);
  });

  it("returns the server's message for a TasksApiError with a different (or no) code", () => {
    expect(
      describeTasksApiError(
        new TasksApiError("task 1 not found", "not_found"),
        "フォールバック",
      ),
    ).toBe("task 1 not found");
    expect(
      describeTasksApiError(
        new TasksApiError("task 1 not found", undefined),
        "フォールバック",
      ),
    ).toBe("task 1 not found");
  });

  it("returns the fallback for a non-Error value", () => {
    expect(describeTasksApiError("not an error", "フォールバック")).toBe(
      "フォールバック",
    );
  });
});

describe("evidenceContentUrl", () => {
  it("builds the content endpoint URL for a task/evidence pair", () => {
    expect(evidenceContentUrl(1, 7)).toBe("/api/tasks/1/evidences/7/content");
  });
});

const SAMPLE_EVIDENCE: TaskEvidence = {
  id: 1,
  task_id: 1,
  kind: "file",
  stored_filename: "abc123.png",
  original_filename: "screenshot.png",
  mime_type: "image/png",
  size_bytes: 100,
  url: null,
  created_at: "2026-09-06T00:00:00.000Z",
};

describe("fetchTaskEvidences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed evidence list", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_EVIDENCE]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const evidences = await fetchTaskEvidences(1);

    expect(evidences).toEqual([SAMPLE_EVIDENCE]);
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/1/evidences");
  });
});

describe("addFileEvidence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a multipart/form-data body with the file under the 'file' field", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(SAMPLE_EVIDENCE),
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["dummy"], "screenshot.png", { type: "image/png" });

    const created = await addFileEvidence(1, file);

    expect(created).toEqual(SAMPLE_EVIDENCE);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/1/evidences");
    expect(options.method).toBe("POST");
    const body = options.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("file")).toBe(file);
  });

  it("rejects with a TasksApiError carrying the code on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: "extension not allowed: a.exe",
            code: "evidence_extension_not_allowed",
          }),
      }),
    );
    const file = new File(["dummy"], "a.exe", { type: "application/x-msdownload" });

    const error: unknown = await addFileEvidence(1, file).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TasksApiError);
    expect((error as TasksApiError).code).toBe(
      "evidence_extension_not_allowed",
    );
  });
});

describe("addLinkEvidence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the url as JSON", async () => {
    const linkEvidence: TaskEvidence = {
      ...SAMPLE_EVIDENCE,
      kind: "link",
      stored_filename: null,
      original_filename: null,
      mime_type: null,
      size_bytes: null,
      url: "https://example.com/doc",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(linkEvidence),
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await addLinkEvidence(1, "https://example.com/doc");

    expect(created).toEqual(linkEvidence);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/1/evidences",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/doc" }),
      }),
    );
  });
});

describe("deleteTaskEvidence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a DELETE request to the evidence endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve(null),
    });
    vi.stubGlobal("fetch", fetchMock);

    await deleteTaskEvidence(1, 7);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/1/evidences/7",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("rejects with a TasksApiError carrying code: task_already_done on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            error: "cannot delete evidence from a task that is already done",
            code: "task_already_done",
          }),
      }),
    );

    const error: unknown = await deleteTaskEvidence(1, 7).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TasksApiError);
    expect((error as TasksApiError).code).toBe("task_already_done");
  });
});
