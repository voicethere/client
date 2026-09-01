import { describe, expect, it, vi } from "vitest";

import {
  acquireAudioInput,
  createSyntheticMicStream,
  getStreamDeviceId,
  SYNTHETIC_MIC_NOISE_GAIN,
} from "./microphone.js";

describe("microphone helpers", () => {
  it("acquireAudioInput returns live stream when getUserMedia succeeds", async () => {
    const track = {
      kind: "audio",
      readyState: "live",
      stop: vi.fn(),
      getSettings: () => ({ deviceId: "mic-a" }),
    } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;

    const result = await acquireAudioInput({
      getUserMedia: async () => stream,
      deviceId: "mic-a",
    });

    expect(result.state).toBe("live");
    expect(result.deviceId).toBe("mic-a");
    expect(result.stream).toBe(stream);
    result.dispose();
    expect(track.stop).toHaveBeenCalled();
  });

  it("acquireAudioInput falls back to synthetic on permission deny", async () => {
    const denied = new DOMException("denied", "NotAllowedError");
    const result = await acquireAudioInput({
      getUserMedia: async () => {
        throw denied;
      },
    });

    expect(result.state).toBe("denied");
    expect(result.deviceId).toBeNull();
    expect(result.stream.getAudioTracks().length).toBeGreaterThan(0);
    result.dispose();
  });

  it("acquireAudioInput uses synthetic when getUserMedia is missing", async () => {
    const result = await acquireAudioInput({});
    expect(result.state).toBe("unavailable");
    expect(result.stream.getAudioTracks()[0]?.readyState).toBe("live");
    result.dispose();
  });

  it("createSyntheticMicStream exposes a live audio track", () => {
    const { stream, dispose } = createSyntheticMicStream();
    expect(stream.getAudioTracks()[0]?.kind).toBe("audio");
    expect(stream.getAudioTracks()[0]?.readyState).toBe("live");
    dispose();
  });

  it("createSyntheticMicStream uses looping white noise with resume and dispose", () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const sourceStop = vi.fn();
    const sourceStart = vi.fn();

    let capturedGainValue: number | undefined;
    let capturedBufferChannel: Float32Array | undefined;
    let capturedLoop: boolean | undefined;

    const gainNode = {
      gain: {
        set value(v: number) {
          capturedGainValue = v;
        },
        get value() {
          return capturedGainValue ?? 0;
        },
      },
      connect: vi.fn(),
    };

    const bufferSource = {
      get loop() {
        return capturedLoop ?? false;
      },
      set loop(v: boolean) {
        capturedLoop = v;
      },
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      start: sourceStart,
      stop: sourceStop,
    };

    const mockCtx = {
      sampleRate: 48000,
      resume,
      close,
      createMediaStreamDestination: () => ({
        stream: {
          getAudioTracks: () => [{ kind: "audio", readyState: "live" }],
          getTracks: () => [{ kind: "audio", readyState: "live" }],
        } as unknown as MediaStream,
      }),
      createGain: () => gainNode,
      createBuffer: (
        _channels: number,
        length: number,
        _sampleRate: number,
      ) => ({
        getChannelData: () => {
          const data = new Float32Array(length);
          for (let i = 0; i < length; i++) {
            data[i] = Math.random() * 2 - 1;
          }
          capturedBufferChannel = data;
          return data;
        },
      }),
      createBufferSource: () => bufferSource,
    };

    const OriginalAudioContext = globalThis.AudioContext;
    // @ts-expect-error test mock
    globalThis.AudioContext = vi.fn(() => mockCtx);

    try {
      const { dispose } = createSyntheticMicStream();

      expect(resume).toHaveBeenCalled();
      expect(capturedGainValue).toBe(SYNTHETIC_MIC_NOISE_GAIN);
      expect(capturedGainValue).toBeGreaterThan(0);
      expect(capturedLoop).toBe(true);
      expect(sourceStart).toHaveBeenCalled();
      expect(bufferSource.buffer).not.toBeNull();
      expect(capturedBufferChannel).toBeDefined();
      expect(capturedBufferChannel!.some((sample) => sample !== 0)).toBe(true);

      dispose();
      expect(sourceStop).toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
    } finally {
      globalThis.AudioContext = OriginalAudioContext;
    }
  });

  it("getStreamDeviceId reads track settings", () => {
    const track = {
      getSettings: () => ({ deviceId: "abc" }),
    } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    expect(getStreamDeviceId(stream)).toBe("abc");
  });
});
