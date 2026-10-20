import { describe, expect, it } from "vitest";

import {
  FRAME_BYTES,
  FRAME_MS,
  PacedMicPump,
  nextFrameWait,
  type PumpClock,
} from "./pacing.js";

/** Fake clock: sleeping advances time, a write can cost time or stall. */
function harness(options: {
  writeCostMs?: number;
  stallOnWrite?: { index: number; ms: number };
  stopAfterFrames: number;
}) {
  let t = 0;
  const clock: PumpClock = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  const writes: { at: number; bytes: number; ms: number; tag: number }[] = [];
  let pump: PacedMicPump;
  const track = {
    async writeSample(data: Uint8Array, durationMs: number) {
      writes.push({
        at: t,
        bytes: data.byteLength,
        ms: durationMs,
        tag: data[0] ?? 0,
      });
      if (options.stallOnWrite?.index === writes.length) {
        t += options.stallOnWrite.ms;
      } else {
        t += options.writeCostMs ?? 0;
      }
      if (writes.length >= options.stopAfterFrames + 1) pump.requestStop();
    },
  };
  pump = new PacedMicPump(track, clock);
  return {
    pump,
    writes,
    /** Runs the pump until `stopAfterFrames` frames were written. */
    async run() {
      pump.start();
      await pump.finished();
    },
  };
}

describe("PacedMicPump", () => {
  it("writes one 20 ms frame per 20 ms from an anchor without drift", async () => {
    const h = harness({ writeCostMs: 1.5, stopAfterFrames: 100 });
    await h.run();
    const frames = h.writes.filter((w) => w.ms === FRAME_MS);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.at - frames[0]!.at).toBeCloseTo(i * FRAME_MS, 5);
    }
    expect(h.pump.reanchors).toBe(0);
  });

  it("re-anchors after a stall and does not burst", async () => {
    const h = harness({
      stallOnWrite: { index: 11, ms: 400 },
      stopAfterFrames: 40,
    });
    await h.run();
    const frames = h.writes.filter((w) => w.ms === FRAME_MS);
    const gaps = frames.slice(1).map((w, i) => w.at - frames[i]!.at);
    // No two frames are ever written closer than one frame apart.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(FRAME_MS);
    expect(h.pump.reanchors).toBe(1);
  });

  it("sends the clip frames in order, then resolves at the last write", async () => {
    const h = harness({ stopAfterFrames: 30 });
    const frames = [1, 2, 3].map((n) => new Uint8Array(FRAME_BYTES).fill(n));
    h.pump.start();
    const speechEnd = await h.pump.play(frames);
    const played = h.writes.filter((w) => w.ms === FRAME_MS);
    // The third clip frame was due 40 ms after the first; speech end is taken right after it.
    expect(speechEnd).toBe(played[2]!.at);
    await h.run();
    const all = h.writes.filter((w) => w.ms === FRAME_MS);
    expect(all.slice(0, 4).map((w) => w.tag)).toEqual([1, 2, 3, 0]);
  });

  it("refuses a second clip while one is playing", async () => {
    const h = harness({ stopAfterFrames: 5 });
    void h.pump.play([new Uint8Array(FRAME_BYTES)]);
    expect(() => h.pump.play([new Uint8Array(FRAME_BYTES)])).toThrow();
  });
});

describe("nextFrameWait", () => {
  it("sleeps until the next due time, and re-anchors when over 100 ms behind", () => {
    expect(nextFrameWait({ anchorMs: 0, sent: 1, nowMs: 5 })).toEqual({
      reanchor: false,
      waitMs: 15,
    });
    expect(nextFrameWait({ anchorMs: 0, sent: 1, nowMs: 60 })).toEqual({
      reanchor: false,
      waitMs: 0,
    });
    expect(nextFrameWait({ anchorMs: 0, sent: 1, nowMs: 200 }).reanchor).toBe(
      true,
    );
  });
});
