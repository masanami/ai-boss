import { describe, expect, it, vi } from "vitest";
import {
  BLOB_URL_REVOKE_DELAY_MS,
  createBlobEvidenceContentOpener,
} from "./open-evidence-content-as-blob";
import type { BlobEvidenceOpenerDeps } from "./open-evidence-content-as-blob";
import { EvidenceNotOpenableError } from "../evidence-content-opener-context";

/** `task-evidences-routes.ts` が返す形の応答（2xx・本文・Content-Disposition）。 */
function contentResponse(disposition: string | null, contentType = "image/png"): Response {
  const headers = new Headers({ "Content-Type": contentType });
  if (disposition !== null) {
    headers.set("Content-Disposition", disposition);
  }
  return new Response(new Blob(["file-body"]), { status: 200, headers });
}

function createDeps(overrides: Partial<BlobEvidenceOpenerDeps> = {}): BlobEvidenceOpenerDeps {
  return {
    fetch: vi.fn(async () => contentResponse("inline")),
    createObjectURL: vi.fn(() => "blob:tauri://localhost/fake-uuid"),
    revokeObjectURL: vi.fn(),
    openWindow: vi.fn(),
    setTimeout: vi.fn((callback: () => void) => {
      callback();
      return 0;
    }),
    ...overrides,
  };
}

describe("createBlobEvidenceContentOpener", () => {
  it("fetches the content URL, opens the resulting blob: URL in a new window, and schedules revocation after 60s", async () => {
    const deps = createDeps();
    const open = createBlobEvidenceContentOpener(deps);

    await open("/api/tasks/1/evidences/2/content");

    expect(deps.fetch).toHaveBeenCalledWith("/api/tasks/1/evidences/2/content");
    expect(deps.createObjectURL).toHaveBeenCalledTimes(1);
    expect(deps.openWindow).toHaveBeenCalledWith("blob:tauri://localhost/fake-uuid");
    // self-review（code-reviewer, CONFIRMED）: 実装から import した定数と比較
    // するだけでは、実装側の値を変えても両辺が一緒に動いて緑のままになる
    // （仮定 A6「60秒」自体を固定できていなかった）。リテラル 60000 でも
    // 固定し、実装がその値からずれたら落ちるようにする。
    expect(BLOB_URL_REVOKE_DELAY_MS).toBe(60_000);
    expect(deps.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(deps.revokeObjectURL).toHaveBeenCalledWith("blob:tauri://localhost/fake-uuid");
  });

  it("does not revoke before the scheduled delay fires (setTimeout callback observed, not invoked early)", async () => {
    let scheduled: (() => void) | undefined;
    const deps = createDeps({
      setTimeout: vi.fn((callback: () => void) => {
        scheduled = callback;
        return 0;
      }),
    });
    const open = createBlobEvidenceContentOpener(deps);

    await open("/api/tasks/1/evidences/2/content");

    expect(deps.revokeObjectURL).not.toHaveBeenCalled();
    scheduled!();
    expect(deps.revokeObjectURL).toHaveBeenCalledWith("blob:tauri://localhost/fake-uuid");
  });

  it("throws and does not open a window when the fetch response is not 2xx", async () => {
    const deps = createDeps({
      fetch: vi.fn(async () => new Response(null, { status: 404 })),
    });
    const open = createBlobEvidenceContentOpener(deps);

    await expect(open("/api/tasks/1/evidences/2/content")).rejects.toThrow();
    expect(deps.openWindow).not.toHaveBeenCalled();
    expect(deps.createObjectURL).not.toHaveBeenCalled();
  });

  // PR #646 の Codex 指摘 P2: Blob に変換すると `Content-Disposition` が
  // 失われるため、変換の前に `inline`（画像・PDF。`task-evidences-routes.ts`
  // の判定）だけを開き、`attachment` 等は開かない（ダウンロードもしない）。
  describe("Content-Disposition による開く／開かないの判定", () => {
    it.each([
      ["attachment（テキスト）", "attachment", "text/plain"],
      [
        "attachment（Office）",
        "attachment",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      ["ヘッダが無い", null, "image/png"],
      ["空文字", "", "image/png"],
      ["種別が attachment でファイル名に inline を含む", 'attachment; filename="inline.png"', "image/png"],
      ["inline を接頭辞に持つ別の語", "inlined", "image/png"],
    ])(
      "does not create a blob URL nor open a window when disposition is %s",
      async (_label, disposition, contentType) => {
        const deps = createDeps({
          fetch: vi.fn(async () => contentResponse(disposition, contentType)),
        });
        const open = createBlobEvidenceContentOpener(deps);

        await expect(open("/api/tasks/1/evidences/2/content")).rejects.toBeInstanceOf(
          EvidenceNotOpenableError,
        );
        expect(deps.createObjectURL).not.toHaveBeenCalled();
        expect(deps.openWindow).not.toHaveBeenCalled();
        expect(deps.setTimeout).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["inline（画像）", "inline", "image/png"],
      ["inline（PDF）", "inline", "application/pdf"],
      ["パラメータ付きの inline", 'inline; filename="a.pdf"', "application/pdf"],
      ["大文字の INLINE", "INLINE", "image/jpeg"],
    ])("opens the blob URL when disposition is %s", async (_label, disposition, contentType) => {
      const deps = createDeps({
        fetch: vi.fn(async () => contentResponse(disposition, contentType)),
      });
      const open = createBlobEvidenceContentOpener(deps);

      await open("/api/tasks/1/evidences/2/content");

      expect(deps.openWindow).toHaveBeenCalledWith("blob:tauri://localhost/fake-uuid");
    });
  });
});
