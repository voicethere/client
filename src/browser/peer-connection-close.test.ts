import { describe, expect, it, vi } from "vitest";

import { closePeerConnectionAwaitable } from "./peer-connection-close.js";

describe("closePeerConnectionAwaitable", () => {
  it("uses sync close when closeAsync is unavailable (browser runtime)", async () => {
    const close = vi.fn();
    const pc = { close } as unknown as RTCPeerConnection;
    const result = await closePeerConnectionAwaitable(pc);
    expect(close).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("closed");
    expect(result.mode).toBe("sync");
    expect(result.timedOut).toBe(false);
  });

  it("awaits closeAsync when available (Node SDK)", async () => {
    let resolved = false;
    const closeAsync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve();
          }, 5);
        }),
    );
    const close = vi.fn();
    const pc = { close, closeAsync } as unknown as RTCPeerConnection;
    const result = await closePeerConnectionAwaitable(pc);
    expect(closeAsync).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(resolved).toBe(true);
    expect(result.status).toBe("closed");
    expect(result.mode).toBe("async");
    expect(result.timedOut).toBe(false);
  });

  it("bounds hung closeAsync with timed_out (not closed)", async () => {
    vi.useFakeTimers();
    try {
      const closeAsync = vi.fn(() => new Promise<void>(() => undefined));
      const pc = {
        close: vi.fn(),
        closeAsync,
      } as unknown as RTCPeerConnection;
      const pending = closePeerConnectionAwaitable(pc, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(result.mode).toBe("async");
      expect(result.status).toBe("timed_out");
      expect(result.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no-ops for null peer connection as closed", async () => {
    const result = await closePeerConnectionAwaitable(null);
    expect(result).toEqual({
      status: "closed",
      mode: "sync",
      durationMs: 0,
      timedOut: false,
    });
  });

  it("reports failed when closeAsync rejects", async () => {
    const closeAsync = vi.fn(async () => {
      throw new Error("native close boom");
    });
    const result = await closePeerConnectionAwaitable({
      close: vi.fn(),
      closeAsync,
    } as unknown as RTCPeerConnection);
    expect(result.status).toBe("failed");
    expect(result.mode).toBe("async");
    expect(result.error).toBeInstanceOf(Error);
  });

  it("reports failed when sync close throws", async () => {
    const result = await closePeerConnectionAwaitable({
      close: () => {
        throw new Error("sync close boom");
      },
    } as unknown as RTCPeerConnection);
    expect(result.status).toBe("failed");
    expect(result.mode).toBe("sync");
    expect(result.error).toBeInstanceOf(Error);
  });
});
