import { describe, expect, it } from "vitest";

import {
  connectBrowserVoiceSession,
  VOICE_AGENT_SERVER_PEER_ID,
} from "./browser-voice-session.js";
import type { SessionErrorEvent } from "../session-errors.js";
import type { WebRtcRuntime } from "./webrtc-runtime.js";

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
  static createAnswerError: Error | null = null;

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

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.remoteDescription = description;
  }

  async addIceCandidate(_candidate: RTCIceCandidateInit): Promise<void> {}

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (MockPeerConnection.createAnswerError) {
      throw MockPeerConnection.createAnswerError;
    }
    return { type: "answer", sdp: "v=0" };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = description;
    this.iceGatheringState = "complete";
    this.onicegatheringstatechange?.();
  }

  close(): void {
    this.connectionState = "closed";
  }
}

describe("connectBrowserVoiceSession offer handler", () => {
  it("emits WEBRTC_SDP_NEGOTIATION_FAILED and rejects wait when createAnswer fails", async () => {
    MockWebSocket.instances = [];
    MockPeerConnection.instances = [];
    MockPeerConnection.createAnswerError = new Error(
      "native createAnswer stalled",
    );

    const sessionErrors: SessionErrorEvent[] = [];
    const runtime: WebRtcRuntime = {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    };

    const session = await connectBrowserVoiceSession({
      credentials: {
        session_id: "session-offer-fail",
        mode: "data",
        room_id: "room-offer-fail",
        join_token: "join",
        signaling_url: "ws://127.0.0.1:8080/ws",
        ice_servers: [],
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      requestMic: false,
      readiness: "data",
      runtime,
      reconnectPolicy: "new-session",
      onSessionError: (event) => sessionErrors.push(event),
    });

    const ws = MockWebSocket.instances[0];
    ws.onmessage?.({
      data: JSON.stringify({
        type: "offer",
        peerId: VOICE_AGENT_SERVER_PEER_ID,
        sdp: { type: "offer", sdp: "v=0" },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(session.waitForConnected(1_000)).rejects.toThrow(
      /offer handler failed at create_answer/,
    );

    expect(sessionErrors).toHaveLength(1);
    expect(sessionErrors[0]?.code).toBe("WEBRTC_SDP_NEGOTIATION_FAILED");
    expect(sessionErrors[0]?.message).toContain("create_answer");
    expect(ws.sent.some((frame) => JSON.parse(frame).type === "answer")).toBe(
      false,
    );
  });
});
