import { describe, expect, it } from "vitest";

import {
  buildWebRtcConnectionStatus,
  deriveWebRtcConnectionPhase,
  isWebRtcConnectionReady,
  resolveReadinessProfile,
  type WebRtcConnectionSnapshot,
} from "./webrtc-connection-status.js";

const connectedBase = (
  overrides: Partial<WebRtcConnectionSnapshot> = {},
): WebRtcConnectionSnapshot => ({
  signalingJoined: true,
  peerConnectionState: "connected",
  inboundAudioTrack: false,
  outboundAudioTrack: false,
  controlChannelOpen: false,
  syncChannelOpen: false,
  ...overrides,
});

describe("webrtc connection readiness", () => {
  it("defaults readiness profile from requestMic", () => {
    expect(resolveReadinessProfile({ requestMic: true })).toBe("voice");
    expect(resolveReadinessProfile({ requestMic: false })).toBe("data");
    expect(
      resolveReadinessProfile({ requestMic: true, readiness: "voice_and_data" }),
    ).toBe("voice_and_data");
  });

  it("requires inbound and outbound audio for voice readiness", () => {
    expect(
      isWebRtcConnectionReady(
        connectedBase({ inboundAudioTrack: true, outboundAudioTrack: true }),
        "voice",
      ),
    ).toBe(true);
    expect(
      isWebRtcConnectionReady(
        connectedBase({ inboundAudioTrack: true }),
        "voice",
      ),
    ).toBe(false);
    expect(
      isWebRtcConnectionReady(
        connectedBase({ outboundAudioTrack: true }),
        "voice",
      ),
    ).toBe(false);
  });

  it("requires both data channels for data readiness", () => {
    expect(
      isWebRtcConnectionReady(
        connectedBase({
          controlChannelOpen: true,
          syncChannelOpen: true,
        }),
        "data",
      ),
    ).toBe(true);
    expect(
      isWebRtcConnectionReady(
        connectedBase({ controlChannelOpen: true }),
        "data",
      ),
    ).toBe(false);
  });

  it("requires media and channels for voice_and_data readiness", () => {
    const ready = connectedBase({
      inboundAudioTrack: true,
      outboundAudioTrack: true,
      controlChannelOpen: true,
      syncChannelOpen: true,
    });
    expect(isWebRtcConnectionReady(ready, "voice_and_data")).toBe(true);
    expect(
      isWebRtcConnectionReady(
        { ...ready, syncChannelOpen: false },
        "voice_and_data",
      ),
    ).toBe(false);
  });

  it("derives awaiting_media and awaiting_channels phases", () => {
    expect(
      deriveWebRtcConnectionPhase(
        connectedBase({ inboundAudioTrack: true }),
        "voice",
      ),
    ).toBe("awaiting_media");
    expect(
      deriveWebRtcConnectionPhase(
        connectedBase({ controlChannelOpen: true }),
        "data",
      ),
    ).toBe("awaiting_channels");
    expect(
      buildWebRtcConnectionStatus(
        connectedBase({
          inboundAudioTrack: true,
          outboundAudioTrack: true,
        }),
        "voice",
      ),
    ).toMatchObject({ phase: "ready", ready: true });
  });
});
