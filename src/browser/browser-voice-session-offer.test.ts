import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectBrowserVoiceSession,
  remoteOfferHasIceUfrag,
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
    return { type: "answer", sdp: "v=0\r\na=ice-ufrag:local\r\n" };
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

function mockRuntime(): WebRtcRuntime {
  return {
    WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
    RTCPeerConnection:
      MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
  };
}

const baseCredentials = {
  session_id: "session-offer-fail",
  mode: "data" as const,
  room_id: "room-offer-fail",
  join_token: "join",
  signaling_url: "ws://127.0.0.1:8080/ws",
  ice_servers: [] as RTCIceServer[],
  expires_at: new Date(Date.now() + 60_000).toISOString(),
};

describe("remoteOfferHasIceUfrag", () => {
  it("accepts offers with a=ice-ufrag", () => {
    expect(
      remoteOfferHasIceUfrag({
        type: "offer",
        sdp: "v=0\r\na=ice-ufrag:AbCd\r\na=ice-pwd:x\r\n",
      }),
    ).toBe(true);
  });

  it("rejects empty or truncated SDP", () => {
    expect(remoteOfferHasIceUfrag({ type: "offer", sdp: "" })).toBe(false);
    expect(remoteOfferHasIceUfrag({ type: "offer", sdp: "v=0\r\n" })).toBe(
      false,
    );
    expect(remoteOfferHasIceUfrag({ type: "offer" })).toBe(false);
    expect(remoteOfferHasIceUfrag(null)).toBe(false);
  });
});

describe("connectBrowserVoiceSession offer handler", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockPeerConnection.instances = [];
    MockPeerConnection.createAnswerError = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits WEBRTC_SDP_NEGOTIATION_FAILED and rejects wait when createAnswer fails", async () => {
    MockPeerConnection.createAnswerError = new Error(
      "native createAnswer stalled",
    );

    const sessionErrors: SessionErrorEvent[] = [];
    const session = await connectBrowserVoiceSession({
      credentials: baseCredentials,
      requestMic: false,
      readiness: "data",
      runtime: mockRuntime(),
      reconnectPolicy: "new-session",
      onSessionError: (event) => sessionErrors.push(event),
    });

    const ws = MockWebSocket.instances[0];
    ws.onmessage?.({
      data: JSON.stringify({
        type: "offer",
        peerId: VOICE_AGENT_SERVER_PEER_ID,
        sdp: { type: "offer", sdp: "v=0\r\na=ice-ufrag:server\r\n" },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(session.waitForConnected(1_000)).rejects.toThrow(
      /offer handler failed at create_answer/,
    );

    expect(sessionErrors).toHaveLength(1);
    expect(sessionErrors[0]?.code).toBe("WEBRTC_SDP_NEGOTIATION_FAILED");
    expect(sessionErrors[0]?.message).toContain("create_answer");
    expect(sessionErrors[0]?.recoverable).toBe(false);
    expect(ws.sent.some((frame) => JSON.parse(frame).type === "answer")).toBe(
      false,
    );
  });

  it("schedules same-session reconnect after offer missing ice-ufrag", async () => {
    const sessionErrors: SessionErrorEvent[] = [];
    const reconnecting: number[] = [];

    const session = await connectBrowserVoiceSession({
      credentials: {
        ...baseCredentials,
        session_id: "session-ice-ufrag",
        room_id: "room-ice-ufrag",
      },
      requestMic: false,
      readiness: "data",
      runtime: mockRuntime(),
      onReconnecting: (attempt) => reconnecting.push(attempt),
      onSessionError: (event) => sessionErrors.push(event),
    });

    // Fake timers only after join — WebSocket open uses queueMicrotask.
    vi.useFakeTimers();
    const firstWs = MockWebSocket.instances[0];
    firstWs.onmessage?.({
      data: JSON.stringify({
        type: "offer",
        peerId: VOICE_AGENT_SERVER_PEER_ID,
        sdp: { type: "offer", sdp: "v=0\r\n" },
      }),
    });
    await Promise.resolve();

    expect(sessionErrors).toHaveLength(1);
    expect(sessionErrors[0]?.code).toBe("WEBRTC_SDP_NEGOTIATION_FAILED");
    expect(sessionErrors[0]?.message).toMatch(/ice-ufrag/i);
    expect(sessionErrors[0]?.recoverable).toBe(true);

    // First reconnect delay is 1000ms (2^(1-1)*1000).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconnecting).toEqual([1]);
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);

    vi.useRealTimers();
    session.disconnect();
  });
});
