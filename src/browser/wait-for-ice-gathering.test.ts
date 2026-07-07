import { describe, expect, it, vi } from "vitest";

import { waitForIceGatheringComplete } from "./wait-for-ice-gathering.js";

describe("waitForIceGatheringComplete", () => {
  it("resolves immediately when gathering is already complete", async () => {
    const pc = {
      iceGatheringState: "complete",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as RTCPeerConnection;

    await expect(waitForIceGatheringComplete(pc)).resolves.toBeUndefined();
    expect(pc.addEventListener).not.toHaveBeenCalled();
  });

  it("waits for icegatheringstatechange to complete", async () => {
    let state: RTCIceGatheringState = "gathering";
    const listeners = new Map<string, () => void>();
    const pc = {
      get iceGatheringState() {
        return state;
      },
      addEventListener: (event: string, handler: () => void) => {
        listeners.set(event, handler);
      },
      removeEventListener: (event: string) => {
        listeners.delete(event);
      },
    } as unknown as RTCPeerConnection;

    const pending = waitForIceGatheringComplete(pc, 5_000);
    state = "complete";
    listeners.get("icegatheringstatechange")?.();

    await expect(pending).resolves.toBeUndefined();
  });

  it("uses onicegatheringstatechange when addEventListener is unavailable (Node SDK)", async () => {
    let state: RTCIceGatheringState = "gathering";
    const debugHandler = vi.fn();
    let handler: ((event: Event) => void) | null = debugHandler;
    const pc = {
      get iceGatheringState() {
        return state;
      },
      get onicegatheringstatechange() {
        return handler;
      },
      set onicegatheringstatechange(next) {
        handler = next;
      },
    } as unknown as RTCPeerConnection;

    const pending = waitForIceGatheringComplete(pc, 5_000);
    expect(handler).not.toBe(debugHandler);
    state = "complete";
    handler?.({} as Event);

    await expect(pending).resolves.toBeUndefined();
    expect(debugHandler).toHaveBeenCalled();
  });

  it("rejects when gathering does not complete before timeout", async () => {
    vi.useFakeTimers();
    try {
      const pc = {
        iceGatheringState: "gathering",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as RTCPeerConnection;

      const pending = waitForIceGatheringComplete(pc, 1_000);
      const assertion = expect(pending).rejects.toThrow(/ICE gathering timeout/);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
