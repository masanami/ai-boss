import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import TaskReferenceText from "./TaskReferenceText";
import type { Task } from "./task";

function makeTask(overrides: Partial<Task> & { id: number }): Task {
  return {
    title: `task-${overrides.id}`,
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
    created_at: new Date(2026, 6, 5).toISOString(),
    updated_at: new Date(2026, 6, 5).toISOString(),
    completed_at: null,
    evidence_required: false,
    committed_start_at: null,
    committed_at: null,
    ...overrides,
  };
}

describe("TaskReferenceText", () => {
  it("wraps a resolved #<id> in an element carrying the task title as its title attribute", () => {
    const task1 = makeTask({ id: 1, title: "見積もり資料の作成" });
    const { container } = render(
      <p>
        <TaskReferenceText text="#1 を進めろ" tasks={[task1]} />
      </p>,
    );

    const referenced = container.querySelector("[title]");
    expect(referenced).not.toBeNull();
    expect(referenced).toHaveAttribute("title", "見積もり資料の作成");
    expect(referenced).toHaveTextContent("#1");
  });

  it("does not add any title-bearing element when the id has no match", () => {
    const task1 = makeTask({ id: 1 });
    const { container } = render(
      <p>
        <TaskReferenceText text="#9999 は不明" tasks={[task1]} />
      </p>,
    );

    expect(container.querySelectorAll("[title]")).toHaveLength(0);
    expect(screen.getByText(/#9999 は不明/)).toBeInTheDocument();
  });

  it("does not decorate anything when the task list is unavailable (null)", () => {
    const { container } = render(
      <p>
        <TaskReferenceText text="#1 を進めろ" tasks={null} />
      </p>,
    );

    expect(container.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("keeps the rendered textContent identical to the original text, decorated or not", () => {
    const task1 = makeTask({ id: 1 });
    const { container } = render(
      <p>
        <TaskReferenceText text="#1 と #9999 を同時に" tasks={[task1]} />
      </p>,
    );

    expect(container.querySelector("p")!.textContent).toBe(
      "#1 と #9999 を同時に",
    );
  });
});
