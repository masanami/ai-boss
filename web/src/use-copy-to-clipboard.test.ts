import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCopyToClipboard } from "./use-copy-to-clipboard";

afterEach(() => {
  vi.restoreAllMocks();
});

function stubClipboard(writeText: ReturnType<typeof vi.fn> | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

describe("useCopyToClipboard", () => {
  it("starts idle and transitions to success when the clipboard write resolves", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    const { result } = renderHook(() => useCopyToClipboard("本文"));
    expect(result.current.copyState.kind).toBe("idle");

    await act(async () => {
      result.current.copy();
    });

    expect(result.current.copyState.kind).toBe("success");
    expect(writeText).toHaveBeenCalledWith("本文");
  });

  it("transitions to failure when the clipboard write rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    stubClipboard(writeText);

    const { result } = renderHook(() => useCopyToClipboard("本文"));

    await act(async () => {
      result.current.copy();
    });

    expect(result.current.copyState.kind).toBe("failure");
  });

  it("transitions to failure without throwing when navigator.clipboard is undefined (non-secure context)", async () => {
    stubClipboard(undefined);

    const { result } = renderHook(() => useCopyToClipboard("本文"));

    await act(async () => {
      expect(() => result.current.copy()).not.toThrow();
    });

    expect(result.current.copyState.kind).toBe("failure");
  });

  it("does nothing when content is null", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    const { result } = renderHook(() => useCopyToClipboard(null));

    await act(async () => {
      result.current.copy();
    });

    expect(result.current.copyState.kind).toBe("idle");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("resets to idle when the content changes (stale result must not stick)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    const { result, rerender } = renderHook(
      ({ content }: { content: string | null }) => useCopyToClipboard(content),
      { initialProps: { content: "本文A" } },
    );
    await act(async () => {
      result.current.copy();
    });
    expect(result.current.copyState.kind).toBe("success");

    rerender({ content: "本文B" });

    expect(result.current.copyState.kind).toBe("idle");
  });
});
