import { describe, expect, it } from "vitest";

import { FRAME_BYTES } from "./pacing.js";
import { clipToFrames, decodeWav } from "./wav.js";

function wav(rate: number, channels: number, samples: number[]): Uint8Array {
  const data = new Uint8Array(samples.length * 2);
  const dv = new DataView(data.buffer);
  samples.forEach((s, i) => dv.setInt16(i * 2, s, true));
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  out.set(new TextEncoder().encode("RIFF"), 0);
  v.setUint32(4, 36 + data.length, true);
  out.set(new TextEncoder().encode("WAVEfmt "), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  out.set(new TextEncoder().encode("data"), 36);
  v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

describe("wav", () => {
  it("turns 16 kHz mono into 20 ms 48 kHz stereo frames", () => {
    const samples = Array.from({ length: 16_000 }, (_, i) =>
      i % 2 ? 1000 : -1000,
    );
    const frames = clipToFrames(decodeWav(wav(16_000, 1, samples)));
    expect(frames).toHaveLength(50); // 1 s / 20 ms
    expect(frames.every((f) => f.byteLength === FRAME_BYTES)).toBe(true);
  });

  it("normalises the peak and writes both channels alike", () => {
    const frames = clipToFrames(decodeWav(wav(48_000, 1, [0, 500, -500, 0])));
    const dv = new DataView(frames[0]!.buffer);
    expect(Math.abs(dv.getInt16(4, true))).toBeGreaterThan(29_000);
    expect(dv.getInt16(4, true)).toBe(dv.getInt16(6, true));
  });

  it("rejects non-WAV and non-16-bit input", () => {
    expect(() => decodeWav(new Uint8Array(20))).toThrow(/WAVE/);
    const bad = wav(16_000, 1, [1, 2]);
    new DataView(bad.buffer).setUint16(34, 8, true);
    expect(() => decodeWav(bad)).toThrow(/16-bit/);
  });
});
