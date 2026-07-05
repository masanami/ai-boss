import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useHealthCheck } from "./use-health-check";

describe("useHealthCheck", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns connected when the health check fetch succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );

    const { result } = renderHook(() => useHealthCheck());

    await waitFor(() => expect(result.current).toBe("connected"));
  });

  it("returns disconnected when the health check fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    const { result } = renderHook(() => useHealthCheck());

    await waitFor(() => expect(result.current).toBe("disconnected"));
  });

  it("returns disconnected when the health check fetch resolves not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const { result } = renderHook(() => useHealthCheck());

    await waitFor(() => expect(result.current).toBe("disconnected"));
  });
});
