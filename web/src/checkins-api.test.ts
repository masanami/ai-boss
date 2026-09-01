import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTodayActivity, postCheckin } from "./checkins-api";
import type { ActivityEvent } from "./activity-event";

const SAMPLE_EVENT: ActivityEvent = {
  id: 1,
  type: "task_start",
  task_id: 1,
  note: null,
  expected_minutes: null,
  created_at: "2026-07-06T00:00:00.000Z",
};

describe("postCheckin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the input and returns the created activity event", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(SAMPLE_EVENT),
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await postCheckin({ type: "task_start", task_id: 1 });

    expect(created).toEqual(SAMPLE_EVENT);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/checkins",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ type: "task_start", task_id: 1 }),
      }),
    );
  });

  it("throws with the server error message when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "task 1 not found" }),
      }),
    );

    await expect(
      postCheckin({ type: "task_start", task_id: 1 }),
    ).rejects.toThrow("task 1 not found");
  });
});

describe("fetchTodayActivity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed activity event list when the request succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_EVENT]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const events = await fetchTodayActivity();

    expect(events).toEqual([SAMPLE_EVENT]);
    expect(fetchMock).toHaveBeenCalledWith("/api/activity/today");
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

    await expect(fetchTodayActivity()).rejects.toThrow("internal error");
  });
});
