import { describe, expect, it, vi } from "vitest";

import { playAudioElement, unlockAudioPlayback } from "./audio-playback.js";

const abort = () =>
  new DOMException("interrupted by a new load request", "AbortError");
const notAllowed = () => new DOMException("blocked", "NotAllowedError");

function elWith(play: () => Promise<void>) {
  const fn = vi.fn(play);
  return { el: { play: fn } as unknown as HTMLAudioElement, play: fn };
}

describe("playAudioElement", () => {
  it("is playing when play() resolves", async () => {
    const { el, play } = elWith(async () => undefined);
    expect(await playAudioElement(el)).toBe("playing");
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("retries once after an AbortError and is playing when the retry resolves", async () => {
    const play = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(abort())
      .mockResolvedValueOnce(undefined);
    const el = { play } as unknown as HTMLAudioElement;
    expect(await playAudioElement(el)).toBe("playing");
    expect(play).toHaveBeenCalledTimes(2);
    expect(await unlockAudioPlayback(el)).toBe(true);
  });

  it("is blocked when the retry after an AbortError is NotAllowedError", async () => {
    const play = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(abort())
      .mockRejectedValueOnce(notAllowed());
    const el = { play } as unknown as HTMLAudioElement;
    expect(await playAudioElement(el)).toBe("blocked");
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("is blocked at once on NotAllowedError, without a retry", async () => {
    const { el, play } = elWith(async () => {
      throw notAllowed();
    });
    expect(await playAudioElement(el)).toBe("blocked");
    expect(play).toHaveBeenCalledTimes(1);
    expect(await unlockAudioPlayback(el)).toBe(false);
  });

  it("treats any other error as blocked without a retry", async () => {
    const { el, play } = elWith(async () => {
      throw new Error("boom");
    });
    expect(await playAudioElement(el)).toBe("blocked");
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("stops after one retry when play() is aborted twice", async () => {
    const { el, play } = elWith(async () => {
      throw abort();
    });
    expect(await playAudioElement(el)).toBe("aborted");
    expect(play).toHaveBeenCalledTimes(2);
    expect(await unlockAudioPlayback(el)).toBe(false);
  });
});
