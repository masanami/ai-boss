import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatView from "./ChatView";
import type { ChatMessage, ChatSession } from "./chat";

const SESSION: ChatSession = {
  id: 1,
  type: "adhoc",
  started_at: "2026-07-05T09:00:00.000Z",
  ended_at: null,
  summary: null,
};

const HISTORY: ChatMessage[] = [
  {
    id: 1,
    session_id: 1,
    role: "user",
    content: "おはようございます",
    created_at: "2026-07-05T09:00:00.000Z",
  },
  {
    id: 2,
    session_id: 1,
    role: "boss",
    content: "今日は A 案件からだ。",
    created_at: "2026-07-05T09:00:05.000Z",
  },
];

const BOSS_REPLY: ChatMessage = {
  id: 3,
  session_id: 1,
  role: "boss",
  content: "B 案件は後回しにしろ。",
  created_at: "2026-07-05T10:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: true, status, json: () => Promise.resolve(body) };
}

function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatView", () => {
  it("shows a loading state while the history is being restored", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<ChatView />);

    expect(screen.getByText("会話履歴を読み込み中…")).toBeInTheDocument();
  });

  it("renders the restored history with role labels", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([SESSION]))
        .mockResolvedValueOnce(jsonResponse(HISTORY)),
    );

    render(<ChatView />);

    await waitFor(() =>
      expect(screen.getByText("おはようございます")).toBeInTheDocument(),
    );
    expect(screen.getByText("今日は A 案件からだ。")).toBeInTheDocument();
    expect(screen.getByText("自分")).toBeInTheDocument();
    expect(screen.getByText("ボス")).toBeInTheDocument();
  });

  it("shows an error state when the history restoration fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    render(<ChatView />);

    await waitFor(() =>
      expect(
        screen.getByText("会話履歴の読み込みに失敗しました"),
      ).toBeInTheDocument(),
    );
  });

  it("sends the draft and renders the boss reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([SESSION]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(
          sseResponse([
            `event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`,
          ]),
        ),
    );

    render(<ChatView />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );

    fireEvent.change(screen.getByLabelText("メッセージ"), {
      target: { value: "相談があります" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() =>
      expect(screen.getByText("B 案件は後回しにしろ。")).toBeInTheDocument(),
    );
    expect(screen.getByText("相談があります")).toBeInTheDocument();
    expect(screen.getByLabelText("メッセージ")).toHaveValue("");
  });

  it("disables the send button while the draft is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse([])));

    render(<ChatView />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "送信" })).toBeInTheDocument(),
    );

    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("メッセージ"), {
      target: { value: "テスト" },
    });
    expect(screen.getByRole("button", { name: "送信" })).toBeEnabled();
  });

  it("renders a tool notice when the boss operates a task", async () => {
    const toolEvent = {
      name: "create_task",
      input: { title: "資料作成" },
      result: JSON.stringify({ id: 5, title: "資料作成" }),
      isError: false,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([SESSION]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(
          sseResponse([
            `event: tool\ndata: ${JSON.stringify(toolEvent)}\n\n`,
            `event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`,
          ]),
        ),
    );

    render(<ChatView />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );

    fireEvent.change(screen.getByLabelText("メッセージ"), {
      target: { value: "タスク化して" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() =>
      expect(
        screen.getByText("ボスがタスクを作成しました: 資料作成"),
      ).toBeInTheDocument(),
    );
  });

  it("shows an alert when the stream reports an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([SESSION]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(
          sseResponse([
            'event: error\ndata: {"error":"ボスの応答中にエラーが発生しました"}\n\n',
          ]),
        ),
    );

    render(<ChatView />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );

    fireEvent.change(screen.getByLabelText("メッセージ"), {
      target: { value: "テスト" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "ボスの応答中にエラーが発生しました",
      ),
    );
  });
});
