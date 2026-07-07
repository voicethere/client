import { describe, expect, it, vi } from "vitest";

import {
  connectBrowserVoiceSession,
  VOICE_AGENT_SERVER_PEER_ID,
  VOICE_CONTROL_CHANNEL_LABEL,
  VOICE_SYNC_CHANNEL_LABEL,
} from "./browser-voice-session.js";
import type { WebRtcConnectionStatus } from "./webrtc-connection-status.js";
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

class MockDataChannel {
  readonly label: string;
  readyState: RTCDataChannelState = "connecting";
  binaryType: BinaryType = "arraybuffer";
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(label: string) {
    this.label = label;
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.({});
  }

  send(_data: unknown): void {}
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

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0" };
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

describe("connectBrowserVoiceSession readiness", () => {
  it("waits for both data channels before waitForConnected resolves in data mode", async () => {
    MockWebSocket.instances = [];
    MockPeerConnection.instances = [];

    const statuses: WebRtcConnectionStatus[] = [];
    const runtime: WebRtcRuntime = {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    };

    const session = await connectBrowserVoiceSession({
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
      onConnectionStatus: (status) => statuses.push(status),
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

    const pc = MockPeerConnection.instances[0];
    const control = new MockDataChannel(VOICE_CONTROL_CHANNEL_LABEL);
    const sync = new MockDataChannel(VOICE_SYNC_CHANNEL_LABEL);
    pc.ondatachannel?.({ channel: control } as RTCDataChannelEvent);
    pc.ondatachannel?.({ channel: sync } as RTCDataChannelEvent);
    pc.connect();

    const pending = session.waitForConnected(500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("still waiting")), 50),
        ),
      ]),
    ).rejects.toThrow("still waiting");

    control.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("still waiting")), 50),
        ),
      ]),
    ).rejects.toThrow("still waiting");

    sync.open();
    await pending;
    expect(session.getConnectionStatus().ready).toBe(true);
    expect(statuses.at(-1)?.phase).toBe("ready");
  });
});
