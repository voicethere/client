import { FRAME_BYTES } from "./pacing.js";

const TARGET_RATE = 48_000;
/** -1 dBFS, like the nwr bench, so a quiet clip still passes the voice activity gate. */
const TARGET_PEAK = Math.round(32767 * 0.891);

export type DecodedWav = {
  sampleRate: number;
  channels: number;
  /** Interleaved s16 samples. */
  samples: Int16Array;
};

/** Reads a 16-bit PCM WAV (mono or stereo, any sample rate). Throws on anything else. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("clip is not a RIFF/WAVE file");
  }
  let format: {
    code: number;
    channels: number;
    rate: number;
    bits: number;
  } | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        code: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) throw new Error("WAV data chunk before fmt chunk");
      const isPcm = format.code === 1 || format.code === 0xfffe;
      if (!isPcm || format.bits !== 16) {
        throw new Error("clip must be 16-bit PCM");
      }
      if (format.channels !== 1 && format.channels !== 2) {
        throw new Error("clip must be mono or stereo");
      }
      const length = Math.min(size, bytes.byteLength - body);
      const count = Math.floor(length / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++)
        samples[i] = view.getInt16(body + i * 2, true);
      return { sampleRate: format.rate, channels: format.channels, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/**
 * Converts a decoded clip to 48 kHz interleaved stereo s16le (what the mic track takes),
 * peak-normalised to -1 dBFS, cut into 20 ms frames. The last frame is padded with zeros.
 */
export function clipToFrames(wav: DecodedWav): Uint8Array[] {
  const inFrames = Math.floor(wav.samples.length / wav.channels);
  const mono = new Float64Array(inFrames);
  for (let i = 0; i < inFrames; i++) {
    let sum = 0;
    for (let c = 0; c < wav.channels; c++)
      sum += wav.samples[i * wav.channels + c]!;
    mono[i] = sum / wav.channels;
  }
  const outFrames = Math.floor((inFrames * TARGET_RATE) / wav.sampleRate);
  const resampled = new Float64Array(outFrames);
  const step = wav.sampleRate / TARGET_RATE;
  let peak = 0;
  for (let i = 0; i < outFrames; i++) {
    const pos = i * step;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, inFrames - 1);
    const frac = pos - lo;
    const value = mono[lo]! * (1 - frac) + mono[hi]! * frac;
    resampled[i] = value;
    peak = Math.max(peak, Math.abs(value));
  }
  const gain = peak > 0 ? TARGET_PEAK / peak : 1;

  const bytesTotal = outFrames * 4;
  const frameCount = Math.max(1, Math.ceil(bytesTotal / FRAME_BYTES));
  const frames: Uint8Array[] = [];
  for (let f = 0; f < frameCount; f++) {
    const frame = new Uint8Array(FRAME_BYTES);
    const view = new DataView(frame.buffer);
    const samplesPerFrame = FRAME_BYTES / 4;
    for (let i = 0; i < samplesPerFrame; i++) {
      const value = resampled[f * samplesPerFrame + i];
      if (value === undefined) break;
      const s = Math.max(-32768, Math.min(32767, Math.round(value * gain)));
      view.setInt16(i * 4, s, true);
      view.setInt16(i * 4 + 2, s, true);
    }
    frames.push(frame);
  }
  return frames;
}
