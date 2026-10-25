import { describe, expect, it, vi } from "vitest";

import {
  connectBrowserVoiceSession,
  VOICE_AGENT_SERVER_PEER_ID,
} from "./browser-voice-session.js";
import type { WebRtcRuntime } from "./webrtc-runtime.js";

const CHROME_ANSWER = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "",
].join("\r\n");

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.OPEN;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.({}));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}
}

class MockPeerConnection {
  static instances: MockPeerConnection[] = [];

  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;

  constructor(_config?: RTCConfiguration) {
    MockPeerConnection.instances.push(this);
  }

  addTrack(): RTCRtpSender {
    return {} as RTCRtpSender;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  async addIceCandidate(_candidate: RTCIceCandidateInit): Promise<void> {}

  createOfferCalls = 0;

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.createOfferCalls++;
    throw new Error("the session must never create an offer");
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: CHROME_ANSWER };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    this.iceGatheringState = "complete";
    this.onicegatheringstatechange?.();
  }

  connect(): void {
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
  }

  close(): void {
    this.connectionState = "closed";
  }
}

async function answerOffer(preferStereoPlayback?: boolean): Promise<MockPeerConnection> {
  MockWebSocket.instances = [];
  MockPeerConnection.instances = [];
  const runtime: WebRtcRuntime = {
    WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
    RTCPeerConnection: MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
  };
  await connectBrowserVoiceSession({
    credentials: {
      session_id: "s",
      mode: "data",
      room_id: "r",
      join_token: "j",
      signaling_url: "ws://127.0.0.1:8080/ws",
      ice_servers: [],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    requestMic: false,
    readiness: "data",
    runtime,
    ...(preferStereoPlayback === undefined ? {} : { preferStereoPlayback }),
  });
  MockWebSocket.instances[0].onmessage?.({
    data: JSON.stringify({
      type: "offer",
      peerId: VOICE_AGENT_SERVER_PEER_ID,
      sdp: { type: "offer", sdp: "v=0\r\na=ice-ufrag:abcd\r\n" },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return MockPeerConnection.instances[0];
}

describe("connectBrowserVoiceSession stereo playback", () => {
  it("answer passed to setLocalDescription asks for stereo Opus", async () => {
    const pc = await answerOffer();
    const sdp = pc.localDescription?.sdp ?? "";
    expect(pc.localDescription?.type).toBe("answer");
    expect(sdp).toContain("stereo=1");
    expect(sdp).toContain("sprop-stereo=1");
  });

  it("preferStereoPlayback false leaves the answer untouched", async () => {
    const pc = await answerOffer(false);
    expect(pc.localDescription?.sdp).toBe(CHROME_ANSWER);
  });

  it("the session never creates an offer", async () => {
    const pc = await answerOffer();
    expect(pc.localDescription?.type).toBe("answer");
    expect(pc.createOfferCalls).toBe(0);
  });
});
