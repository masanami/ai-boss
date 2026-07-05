import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TaskForm from "./TaskForm";

describe("TaskForm", () => {
  it("calls onCreate with the entered title when submitted", async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    render(<TaskForm onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "資料を作る" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(onCreate).toHaveBeenCalledWith({
      title: "資料を作る",
      description: null,
      priority: null,
      due_at: null,
    });
    await waitFor(() =>
      expect(screen.getByLabelText("タイトル")).toHaveValue(""),
    );
  });

  it("calls onCreate with all optional fields filled in", async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    render(<TaskForm onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "資料を作る" },
    });
    fireEvent.change(screen.getByLabelText("説明"), {
      target: { value: "月次報告資料" },
    });
    fireEvent.change(screen.getByLabelText("優先度"), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByLabelText("締切"), {
      target: { value: "2026-07-10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(onCreate).toHaveBeenCalledWith({
      title: "資料を作る",
      description: "月次報告資料",
      priority: "high",
      due_at: "2026-07-10",
    });
    await waitFor(() =>
      expect(screen.getByLabelText("タイトル")).toHaveValue(""),
    );
  });

  it("does not call onCreate when the title is empty", () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    render(<TaskForm onCreate={onCreate} />);

    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(onCreate).not.toHaveBeenCalled();
  });

  it("does not call onCreate when the title is whitespace only", () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    render(<TaskForm onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(onCreate).not.toHaveBeenCalled();
  });

  it("clears the fields after a successful submit", async () => {
    render(<TaskForm onCreate={vi.fn().mockResolvedValue(true)} />);

    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "資料を作る" },
    });
    fireEvent.change(screen.getByLabelText("説明"), {
      target: { value: "月次報告資料" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() =>
      expect(screen.getByLabelText("タイトル")).toHaveValue(""),
    );
    expect(screen.getByLabelText("説明")).toHaveValue("");
  });

  it("keeps the entered values when the submit fails", async () => {
    const onCreate = vi.fn().mockResolvedValue(false);
    render(<TaskForm onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "資料を作る" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(screen.getByLabelText("タイトル")).toHaveValue("資料を作る");
  });
});
