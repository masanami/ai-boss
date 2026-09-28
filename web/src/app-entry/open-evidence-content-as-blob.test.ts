import { describe, expect, it, vi } from "vitest";
import {
  BLOB_URL_REVOKE_DELAY_MS,
  createBlobEvidenceContentOpener,
} from "./open-evidence-content-as-blob";
import type { BlobEvidenceOpenerDeps } from "./open-evidence-content-as-blob";

function createDeps(overrides: Partial<BlobEvidenceOpenerDeps> = {}): BlobEvidenceOpenerDeps {
  return {
    fetch: vi.fn(async () => new Response(new Blob(["file-body"]), { status: 200 })),
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
});
