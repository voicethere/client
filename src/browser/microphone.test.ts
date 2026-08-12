import { describe, expect, it, vi } from "vitest";

import {
  acquireAudioInput,
  createSyntheticMicStream,
  getStreamDeviceId,
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
