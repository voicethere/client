import { describe, expect, it } from "vitest";

import {
  buildWebRtcConnectionStatus,
  deriveWebRtcConnectionPhase,
  formatWebRtcConnectTimeoutMessage,
  isWebRtcConnectionReady,
  resolveHalfOpenFailFastMs,
  resolveReadinessProfile,
  usesHalfOpenFailFast,
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
      resolveReadinessProfile({
        requestMic: true,
        readiness: "voice_and_data",
      }),
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

  it("resolves half-open fail-fast only for voice profiles", () => {
    expect(usesHalfOpenFailFast("voice")).toBe(true);
    expect(usesHalfOpenFailFast("voice_and_data")).toBe(true);
    expect(usesHalfOpenFailFast("data")).toBe(false);
    expect(resolveHalfOpenFailFastMs("voice", 60_000)).toBe(20_000);
    expect(resolveHalfOpenFailFastMs("voice", 15_000)).toBe(15_000);
    expect(resolveHalfOpenFailFastMs("data", 60_000)).toBeNull();
  });

  it("formats connect timeout messages with half_open diagnostics", () => {
    const status = buildWebRtcConnectionStatus(
      connectedBase({
        inboundAudioTrack: true,
        outboundAudioTrack: false,
      }),
      "voice",
    );
    expect(
      formatWebRtcConnectTimeoutMessage(status, {
        elapsedMs: 20_000,
        halfOpen: true,
        halfOpenElapsedMs: 20_050,
      }),
    ).toBe(
      "WebRTC half-open timeout after 20000ms; half_open=true; phase=awaiting_media; pc=connected; signalingJoined=true; control=false; sync=false; half_open_elapsed_ms=20050",
    );
    expect(
      formatWebRtcConnectTimeoutMessage(status, {
        elapsedMs: 60_000,
        halfOpen: false,
      }),
    ).toBe(
      "WebRTC connect timeout after 60000ms; half_open=false; phase=awaiting_media; pc=connected; signalingJoined=true; control=false; sync=false",
    );
  });
});
