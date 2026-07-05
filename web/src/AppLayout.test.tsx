import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AppLayout from "./AppLayout";

beforeEach(() => {
  // Default stub is a fetch that never resolves, so layout-only tests never
  // trigger a post-render state update (and the resulting "not wrapped in
  // act" warning). Tests that care about the health check status override
  // this with a resolving/rejecting mock.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppLayout", () => {
  it("renders the four nav placeholder items", () => {
    render(<AppLayout />);

    expect(
      screen.getByRole("navigation", { name: "メインナビゲーション" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "チャット" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "タスク" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "決定ログ" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "設定" })).toBeInTheDocument();
  });

  it("renders the main area with a boss dialogue placeholder", () => {
    render(<AppLayout />);

    expect(
      screen.getByRole("main", { name: "ボスとの対話" }),
    ).toBeInTheDocument();
  });

  it("renders the right side panel with today's tasks and progress placeholders", () => {
    render(<AppLayout />);

    expect(
      screen.getByRole("complementary", { name: "サイドパネル" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "今日のタスク" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "進捗" }),
    ).toBeInTheDocument();
  });

  it("renders the checkin panel above the other side panel sections", () => {
    render(<AppLayout />);

    expect(
      screen.getByRole("region", { name: "チェックイン" }),
    ).toBeInTheDocument();
  });

  it("renders the header title", () => {
    render(<AppLayout />);

    expect(
      screen.getByRole("heading", { name: "ai-boss" }),
    ).toBeInTheDocument();
  });

  it("shows the connected status in the header once the health check succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );

    render(<AppLayout />);

    await waitFor(() =>
      expect(screen.getByText("接続 OK")).toBeInTheDocument(),
    );
  });

  it("shows the disconnected status in the header when the health check fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    render(<AppLayout />);

    await waitFor(() =>
      expect(screen.getByText("サーバー未接続")).toBeInTheDocument(),
    );
  });

  it("switches the main area to the task board when the task nav item is clicked", () => {
    render(<AppLayout />);

    fireEvent.click(screen.getByRole("button", { name: "タスク" }));

    expect(
      screen.getByRole("main", { name: "タスクボード" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("main", { name: "ボスとの対話" }),
    ).not.toBeInTheDocument();
  });

  it("switches back to the chat placeholder when the chat nav item is clicked", () => {
    render(<AppLayout />);

    fireEvent.click(screen.getByRole("button", { name: "タスク" }));
    fireEvent.click(screen.getByRole("button", { name: "チャット" }));

    expect(
      screen.getByRole("main", { name: "ボスとの対話" }),
    ).toBeInTheDocument();
  });
});
