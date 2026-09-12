import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TaskCard from "./TaskCard";
import type { Task } from "./task";
import type { TaskEvidence } from "./task-evidence";
import { TASK_DRAG_DATA_TYPE } from "./task-dnd";

// jsdom は DataTransfer を実装しないため、setData/getData を持つ簡易スタブを
// 自前で用意する（Issue #122）。
function makeDataTransfer() {
  const store = new Map<string, string>();
  return {
    setData: vi.fn((type: string, value: string) => {
      store.set(type, value);
    }),
    getData: vi.fn((type: string) => store.get(type) ?? ""),
    dropEffect: "",
    effectAllowed: "",
  };
}

const BASE_TASK: Task = {
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

function makeEvidence(
  overrides: Partial<TaskEvidence> & { id: number; kind: "file" | "link" },
): TaskEvidence {
  return {
    task_id: 1,
    stored_filename: null,
    original_filename: null,
    mime_type: null,
    size_bytes: null,
    url: null,
    created_at: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("TaskCard", () => {
  // 編集モードに入るとエビデンス一覧を取得する（AC-67〜71・77・78）。
  // エビデンスと無関係な既存テストでも「編集」を押すたびに GET が飛ぶため、
  // 既定で空配列を返すフォールバックを用意し、個別テストは
  // mockResolvedValueOnce で先頭の GET だけ上書きする。
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the task title", () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );

    expect(
      screen.getByRole("heading", { name: "資料を作る" }),
    ).toBeInTheDocument();
  });

  it("shows the priority as a boss decision in Japanese", () => {
    render(
      <TaskCard
        task={{ ...BASE_TASK, priority: "high" }}
        onStatusChange={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText("ボス決定: 優先度 高")).toBeInTheDocument();
  });

  it("hides the priority line when priority is null", () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );

    expect(screen.queryByText(/ボス決定: 優先度/)).not.toBeInTheDocument();
  });

  it("shows the due date as a boss decision", () => {
    render(
      <TaskCard
        task={{ ...BASE_TASK, due_at: "2026-07-10" }}
        onStatusChange={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(
      screen.getByText("ボス決定: 締切 2026-07-10"),
    ).toBeInTheDocument();
  });

  it("hides the due date line when due_at is null", () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );

    expect(screen.queryByText(/ボス決定: 締切/)).not.toBeInTheDocument();
  });

  it("shows the boss comment when present", () => {
    render(
      <TaskCard
        task={{ ...BASE_TASK, boss_comment: "早めに着手しろ" }}
        onStatusChange={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(
      screen.getByText("ボスコメント: 早めに着手しろ"),
    ).toBeInTheDocument();
  });

  it("hides the boss comment line when boss_comment is null", () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );

    expect(screen.queryByText(/ボスコメント/)).not.toBeInTheDocument();
  });

  it("calls onStatusChange with the new status when the status select changes", () => {
    const onStatusChange = vi.fn();
    render(
      <TaskCard
        task={BASE_TASK}
        onStatusChange={onStatusChange}
        onEdit={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("ステータス"), {
      target: { value: "in_progress" },
    });

    expect(onStatusChange).toHaveBeenCalledWith(1, "in_progress");
  });

  it("enters edit mode with fields pre-filled when the edit button is clicked", () => {
    render(
      <TaskCard
        task={{ ...BASE_TASK, priority: "medium", due_at: "2026-07-10" }}
        onStatusChange={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));

    expect(screen.getByLabelText("タイトル")).toHaveValue("資料を作る");
    expect(screen.getByLabelText("締切")).toHaveValue("2026-07-10");
  });

  it("calls onEdit with the updated fields when the edit form is submitted", async () => {
    const onEdit = vi.fn().mockResolvedValue(true);
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={onEdit} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "資料を仕上げる" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onEdit).toHaveBeenCalledWith(1, {
      title: "資料を仕上げる",
      description: null,
      priority: null,
      due_at: null,
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("form", { name: "タスクを編集" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("stays in edit mode when the update fails", async () => {
    const onEdit = vi.fn().mockResolvedValue(false);
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={onEdit} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "資料を仕上げる" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onEdit).toHaveBeenCalled());
    expect(screen.getByLabelText("タイトル")).toHaveValue("資料を仕上げる");
  });

  it("calls onEdit with all fields when they are edited to non-null values", () => {
    const onEdit = vi.fn().mockResolvedValue(true);
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={onEdit} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("説明"), {
      target: { value: "月次報告資料" },
    });
    fireEvent.change(screen.getByLabelText("優先度"), {
      target: { value: "low" },
    });
    fireEvent.change(screen.getByLabelText("締切"), {
      target: { value: "2026-07-15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onEdit).toHaveBeenCalledWith(1, {
      title: "資料を作る",
      description: "月次報告資料",
      priority: "low",
      due_at: "2026-07-15",
    });
  });

  it("normalizes an ISO datetime due_at to its date part for display and editing", () => {
    render(
      <TaskCard
        task={{ ...BASE_TASK, due_at: "2026-07-10T09:00:00.000Z" }}
        onStatusChange={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText("ボス決定: 締切 2026-07-10")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    expect(screen.getByLabelText("締切")).toHaveValue("2026-07-10");
  });

  it("is draggable so it can be dropped into another column", () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );

    expect(
      screen.getByRole("heading", { name: "資料を作る" }).closest(".task-card"),
    ).toHaveAttribute("draggable", "true");
  });

  it("sets the task id on the dataTransfer when a drag starts from the card", () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );

    const card = screen
      .getByRole("heading", { name: "資料を作る" })
      .closest(".task-card") as HTMLElement;
    const dataTransfer = makeDataTransfer();

    fireEvent.dragStart(card, { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledWith(
      TASK_DRAG_DATA_TYPE,
      "1",
    );
  });

  it("does not start a drag from the status select (keeps the pulldown clickable)", () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );

    const dataTransfer = makeDataTransfer();
    const dispatched = fireEvent.dragStart(screen.getByLabelText("ステータス"), {
      dataTransfer,
    });

    expect(dispatched).toBe(false); // preventDefault() が呼ばれた
    expect(dataTransfer.setData).not.toHaveBeenCalled();
  });

  it("does not start a drag from the edit button (keeps it clickable)", () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );

    const dataTransfer = makeDataTransfer();
    const dispatched = fireEvent.dragStart(
      screen.getByRole("button", { name: "編集" }),
      { dataTransfer },
    );

    expect(dispatched).toBe(false);
    expect(dataTransfer.setData).not.toHaveBeenCalled();
  });

  it("discards edits and returns to view mode when cancel is clicked", () => {
    const onEdit = vi.fn();
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={onEdit} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "変更中のタイトル" },
    });
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(onEdit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "資料を作る" }),
    ).toBeInTheDocument();
  });

  it("shows the list of attached evidences (filenames and URLs) (AC-69)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            makeEvidence({ id: 1, kind: "file", original_filename: "a.png" }),
            makeEvidence({
              id: 2,
              kind: "link",
              url: "https://example.com/doc",
            }),
          ]),
      }),
    );

    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "編集" }));

    await waitFor(() => expect(screen.getByText("a.png")).toBeInTheDocument());
    expect(screen.getByText("https://example.com/doc")).toBeInTheDocument();
  });

  it("shows a message when there are no attached evidences yet", async () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "編集" }));

    await waitFor(() =>
      expect(screen.getByText("まだエビデンスはありません")).toBeInTheDocument(),
    );
  });

  it("adds a file evidence when a file is selected (AC-67)", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    const created = makeEvidence({
      id: 10,
      kind: "file",
      original_filename: "shot.png",
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(created),
    });
    // 追加成功後の一覧再取得（use-task-evidences が resync する）
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([created]),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    await waitFor(() =>
      expect(screen.getByText("まだエビデンスはありません")).toBeInTheDocument(),
    );

    const file = new File(["dummy"], "shot.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("エビデンスファイル"), {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect(screen.getByText("shot.png")).toBeInTheDocument(),
    );
    const [url, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/tasks/1/evidences");
    expect(options.method).toBe("POST");
    expect(options.body).toBeInstanceOf(FormData);
  });

  it("adds a link evidence when a URL is entered and submitted (AC-68)", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    const created = makeEvidence({
      id: 11,
      kind: "link",
      url: "https://example.com/doc",
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(created),
    });
    // 追加成功後の一覧再取得（use-task-evidences が resync する）
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([created]),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    await waitFor(() =>
      expect(screen.getByText("まだエビデンスはありません")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("エビデンスURL"), {
      target: { value: "https://example.com/doc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "URLを追加" }));

    await waitFor(() =>
      expect(screen.getByText("https://example.com/doc")).toBeInTheDocument(),
    );
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/tasks/1/evidences",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/doc" }),
      }),
    ]);
  });

  // URL 入力は編集フォーム（送信ボタン「保存」を持つ）の内側にあるため、
  // Enter の暗黙送信を捕まえないとタスク編集が保存されて編集モードが閉じ、
  // 入力した URL は追加されないまま捨てられる（入力の消失）。
  it("adds the link evidence when Enter is pressed in the URL field, instead of submitting the edit form", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    const created = makeEvidence({
      id: 12,
      kind: "link",
      url: "https://example.com/enter",
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(created),
    });
    // 追加成功後の一覧再取得（use-task-evidences が resync する）
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([created]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const onEdit = vi.fn();
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={onEdit} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    await waitFor(() =>
      expect(screen.getByText("まだエビデンスはありません")).toBeInTheDocument(),
    );

    const urlField = screen.getByLabelText("エビデンスURL");
    fireEvent.change(urlField, {
      target: { value: "https://example.com/enter" },
    });
    // fireEvent は preventDefault が呼ばれると false を返す。jsdom は HTML の
    // 暗黙送信を実装しないため「送信されないこと」を直接は観測できず、
    // preventDefault が呼ばれた事実で担保する（実ブラウザではこれが暗黙送信を
    // 止める）。
    const notCancelled = fireEvent.keyDown(urlField, {
      key: "Enter",
      cancelable: true,
    });
    expect(notCancelled).toBe(false);

    await waitFor(() =>
      expect(screen.getByText("https://example.com/enter")).toBeInTheDocument(),
    );
    // 編集モードは閉じない
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("エビデンスURL")).toBeInTheDocument();
  });

  it("removes an evidence from the list when deleted (AC-70)", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve([
          makeEvidence({ id: 5, kind: "file", original_filename: "a.png" }),
        ]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: () => Promise.resolve(null),
    });
    // 削除成功後の一覧再取得（use-task-evidences が resync する）
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    await waitFor(() => expect(screen.getByText("a.png")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "削除" }));

    await waitFor(() =>
      expect(screen.queryByText("a.png")).not.toBeInTheDocument(),
    );
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/tasks/1/evidences/5",
      expect.objectContaining({ method: "DELETE" }),
    ]);
  });

  // #3 経路 A: 一覧の取得に失敗して status が "error" のとき、追加が成功しても
  // 一覧が描画されないと、追加分は不可視の state に入るだけで画面に何も現れず、
  // ユーザーは失敗したと誤認して再アップロードする（重複・件数上限の消費）。
  // 追加成功後に一覧を取り直すことで、取得できていなかった既存分もここで出る。
  it("shows the evidence list after a successful add even when the initial fetch failed", async () => {
    const fetchMock = vi.fn();
    // 初回 GET は失敗（status: "error"）
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "boom" }),
    });
    const created = makeEvidence({
      id: 21,
      kind: "link",
      url: "https://example.com/after-error",
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(created),
    });
    // 追加成功後の再取得は成功し、既存分も含めた一覧が返る
    const existing = makeEvidence({
      id: 20,
      kind: "file",
      original_filename: "existing.png",
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([existing, created]),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    await waitFor(() =>
      expect(
        screen.getByText("エビデンスの取得に失敗しました"),
      ).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("エビデンスURL"), {
      target: { value: "https://example.com/after-error" },
    });
    fireEvent.click(screen.getByRole("button", { name: "URLを追加" }));

    await waitFor(() =>
      expect(
        screen.getByText("https://example.com/after-error"),
      ).toBeInTheDocument(),
    );
    // 取得できていなかった既存分も表示され、エラー表示は消える
    expect(screen.getByText("existing.png")).toBeInTheDocument();
    expect(
      screen.queryByText("エビデンスの取得に失敗しました"),
    ).not.toBeInTheDocument();
  });

  // #4: サーバの英語文言をそのまま出さず、code に対応する UI 所有の日本語文言を
  // 表示する（決定 2-g）。
  it("shows a Japanese message keyed by the error code, not the server's wording", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          error: "extension not allowed: evil.exe",
          code: "evidence_extension_not_allowed",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    await waitFor(() =>
      expect(screen.getByText("まだエビデンスはありません")).toBeInTheDocument(),
    );

    const file = new File(["dummy"], "evil.exe", {
      type: "application/octet-stream",
    });
    fireEvent.change(screen.getByLabelText("エビデンスファイル"), {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          "この形式のファイルは添付できません（画像・PDF・テキスト・Office 文書のみ）",
        ),
      ).toBeInTheDocument(),
    );
    // サーバの英語文言は露出しない
    expect(
      screen.queryByText("extension not allowed: evil.exe"),
    ).not.toBeInTheDocument();
  });

  it("links a file evidence to the content endpoint (AC-77)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            makeEvidence({ id: 7, kind: "file", original_filename: "a.png" }),
          ]),
      }),
    );

    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "編集" }));

    await waitFor(() =>
      expect(screen.getByText("a.png").closest("a")).toHaveAttribute(
        "href",
        "/api/tasks/1/evidences/7/content",
      ),
    );
  });

  it("links a link evidence to its saved url (AC-78)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            makeEvidence({
              id: 8,
              kind: "link",
              url: "https://example.com/x",
            }),
          ]),
      }),
    );

    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "編集" }));

    await waitFor(() =>
      expect(
        screen.getByText("https://example.com/x").closest("a"),
      ).toHaveAttribute("href", "https://example.com/x"),
    );
  });

  it("includes evidence_required in the patch when toggled (AC-71)", () => {
    const onEdit = vi.fn().mockResolvedValue(true);
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={onEdit} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.click(screen.getByLabelText("エビデンスを必須にする"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onEdit).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ evidence_required: true }),
    );
  });

  it("does not include evidence_required in the patch when it was not toggled", () => {
    const onEdit = vi.fn().mockResolvedValue(true);
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={onEdit} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onEdit).toHaveBeenCalledWith(1, {
      title: "資料を作る",
      description: null,
      priority: null,
      due_at: null,
    });
  });

  // Issue #470 (親 #444 決定1): タスクカードからのメンタリング起動。
  // 表示モードのアクション行に「メンタリングする」ボタンを置く。表示条件は
  // `onStartMentoring` が null/undefined でないこと（呼び出し元 = AppLayout
  // が adhoc 区間かどうかで渡す値を決める。判断はこのコンポーネントの外）。
  describe("メンタリングする ボタン (Issue #470)", () => {
    it("shows a メンタリングする button when onStartMentoring is provided (AC-1)", () => {
      render(
        <TaskCard
          task={BASE_TASK}
          onStatusChange={vi.fn()}
          onEdit={vi.fn()}
          onStartMentoring={vi.fn()}
        />,
      );

      expect(
        screen.getByRole("button", { name: "メンタリングする" }),
      ).toBeInTheDocument();
    });

    // 変異確認の対になるテスト（表示条件を「常に表示」に壊すとこちらが落ち、
    // 「常に非表示」に壊すと上の AC-1 側が落ちる）。
    it("does not show the button when onStartMentoring is null (meeting in progress, AC-2)", () => {
      render(
        <TaskCard
          task={BASE_TASK}
          onStatusChange={vi.fn()}
          onEdit={vi.fn()}
          onStartMentoring={null}
        />,
      );

      expect(
        screen.queryByRole("button", { name: "メンタリングする" }),
      ).not.toBeInTheDocument();
    });

    it("does not show the button when onStartMentoring is not provided at all", () => {
      render(
        <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
      );

      expect(
        screen.queryByRole("button", { name: "メンタリングする" }),
      ).not.toBeInTheDocument();
    });

    // Issue #489 (S1a・決定9): 引数は id ではなくカードが表示している
    // タスクそのもの。呼び出し元（AppLayout）が id からタスクを引き直す
    // 経路（とその失敗時フォールバック `?? ""`）を消すための契約である。
    it("calls onStartMentoring with the task itself (not just its id) when clicked (S1a, 決定9)", () => {
      const onStartMentoring = vi.fn();
      render(
        <TaskCard
          task={BASE_TASK}
          onStatusChange={vi.fn()}
          onEdit={vi.fn()}
          onStartMentoring={onStartMentoring}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "メンタリングする" }));

      expect(onStartMentoring).toHaveBeenCalledWith(BASE_TASK);
      // 引数はタイトルも含むタスク全体である（id だけを渡す実装に戻すと
      // 上の toHaveBeenCalledWith と併せてここが落ちる）。
      const [argument] = onStartMentoring.mock.calls[0] as [Task];
      expect(argument.id).toBe(1);
      expect(argument.title).toBe("資料を作る");
    });

    // Issue #489 (S1a・決定8): 送信中・セッション切替中は「描画したまま
    // 非活性」にする。会（朝会・夕会）中の非表示（`onStartMentoring = null`）
    // とは別の状態であり、同じ表現に潰さない。
    describe("startMentoringDisabled (Issue #489, S1a 決定8)", () => {
      it("renders the button disabled when startMentoringDisabled is true", () => {
        render(
          <TaskCard
            task={BASE_TASK}
            onStatusChange={vi.fn()}
            onEdit={vi.fn()}
            onStartMentoring={vi.fn()}
            startMentoringDisabled
          />,
        );

        expect(
          screen.getByRole("button", { name: "メンタリングする" }),
        ).toBeDisabled();
      });

      // 非活性であって非表示ではない（決定8: 送信のたびにボタンが消えて
      // 戻るレイアウト移動を避ける）。
      it("keeps the button rendered while disabled (disabled, not hidden)", () => {
        render(
          <TaskCard
            task={BASE_TASK}
            onStatusChange={vi.fn()}
            onEdit={vi.fn()}
            onStartMentoring={vi.fn()}
            startMentoringDisabled
          />,
        );

        expect(
          screen.getByRole("button", { name: "メンタリングする" }),
        ).toBeInTheDocument();
      });

      it("does not call onStartMentoring when the disabled button is clicked", () => {
        const onStartMentoring = vi.fn();
        render(
          <TaskCard
            task={BASE_TASK}
            onStatusChange={vi.fn()}
            onEdit={vi.fn()}
            onStartMentoring={onStartMentoring}
            startMentoringDisabled
          />,
        );

        fireEvent.click(
          screen.getByRole("button", { name: "メンタリングする" }),
        );

        expect(onStartMentoring).not.toHaveBeenCalled();
      });

      // 除外側（上の 3 件が恒真にならないための対）。
      it("renders the button enabled when startMentoringDisabled is false", () => {
        render(
          <TaskCard
            task={BASE_TASK}
            onStatusChange={vi.fn()}
            onEdit={vi.fn()}
            onStartMentoring={vi.fn()}
            startMentoringDisabled={false}
          />,
        );

        expect(
          screen.getByRole("button", { name: "メンタリングする" }),
        ).toBeEnabled();
      });

      it("renders the button enabled when startMentoringDisabled is omitted", () => {
        render(
          <TaskCard
            task={BASE_TASK}
            onStatusChange={vi.fn()}
            onEdit={vi.fn()}
            onStartMentoring={vi.fn()}
          />,
        );

        expect(
          screen.getByRole("button", { name: "メンタリングする" }),
        ).toBeEnabled();
      });
    });

    // 決定1: 未保存の編集を抱えたまま画面が切り替わる論点を避けるため、
    // 編集モード内には置かない。
    it("does not show the button in edit mode", () => {
      render(
        <TaskCard
          task={BASE_TASK}
          onStatusChange={vi.fn()}
          onEdit={vi.fn()}
          onStartMentoring={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "編集" }));

      expect(
        screen.queryByRole("button", { name: "メンタリングする" }),
      ).not.toBeInTheDocument();
    });

    // AC-5/AC-6/AC-7: 既存の表示テキスト・ボス決定表示・操作項目は変わらない。
    it("does not change the existing view-mode actions (status select, edit button) (AC-7)", () => {
      render(
        <TaskCard
          task={BASE_TASK}
          onStatusChange={vi.fn()}
          onEdit={vi.fn()}
          onStartMentoring={vi.fn()}
        />,
      );

      expect(screen.getByLabelText("ステータス")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "編集" }),
      ).toBeInTheDocument();
    });
  });
});
