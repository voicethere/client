import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectBrowserVoiceSession,
  VOICE_AGENT_SERVER_PEER_ID,
  VOICE_CONTROL_CHANNEL_LABEL,
  VOICE_SYNC_CHANNEL_LABEL,
} from "./browser-voice-session.js";
import { CLIENT_CAPABILITIES } from "./client-capabilities.js";
import type { VoiceSessionDiagnosticEvent } from "./voice-session-diagnostics.js";
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

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
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
  static useCloseAsync = false;
  static closeAsyncCalls = 0;
  static closeAsyncReject = false;

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
  readonly config: RTCConfiguration | undefined;
  closeCalls = 0;

  constructor(config?: RTCConfiguration) {
    this.config = config;
    MockPeerConnection.instances.push(this);
    if (MockPeerConnection.useCloseAsync) {
      (this as { closeAsync?: () => Promise<void> }).closeAsync = async () => {
        MockPeerConnection.closeAsyncCalls += 1;
        if (MockPeerConnection.closeAsyncReject) {
          throw new Error("native close boom");
        }
      };
    }
  }

  addTrack(): RTCRtpSender {
    return {} as RTCRtpSender;
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.remoteDescription = description;
  }

  async addIceCandidate(_candidate: RTCIceCandidateInit): Promise<void> {}

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\n" };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = description;
    this.iceGatheringState = "complete";
    this.onicegatheringstatechange?.();
  }

  close(): void {
    this.closeCalls += 1;
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }

  connect(): void {
    this.connectionState = "connected";
    this.iceConnectionState = "connected";
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }

  failConnection(): void {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }
}

function sendOffer(ws: MockWebSocket): void {
  ws.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      peerId: VOICE_AGENT_SERVER_PEER_ID,
      sdp: {
        type: "offer",
        sdp: "v=0\r\na=ice-ufrag:test\r\na=ice-pwd:pwd\r\n",
      },
    }),
  });
  const pc = MockPeerConnection.instances.at(-1);
  if (!pc) return;
  queueMicrotask(() => {
    const control = new MockDataChannel(VOICE_CONTROL_CHANNEL_LABEL);
    const sync = new MockDataChannel(VOICE_SYNC_CHANNEL_LABEL);
    pc.ondatachannel?.({
      channel: control,
    } as RTCDataChannelEvent);
    pc.ondatachannel?.({ channel: sync } as RTCDataChannelEvent);
    control.open();
    sync.open();
  });
}

function openDataChannels(pc: MockPeerConnection): void {
  pc.connect();
}

const credentials = {
  session_id: "sess-1",
  mode: "data" as const,
  room_id: "room-1",
  join_token: "join",
  signaling_url: "ws://127.0.0.1:8080/ws",
  ice_servers: [],
  expires_at: new Date(Date.now() + 60_000).toISOString(),
};

describe("BrowserVoiceSession cleanup + retained transport behavior", () => {
  afterEach(() => {
    MockWebSocket.instances = [];
    MockPeerConnection.instances = [];
    MockPeerConnection.useCloseAsync = false;
    MockPeerConnection.closeAsyncCalls = 0;
    MockPeerConnection.closeAsyncReject = false;
  });

  it("does not automatically reconstruct a PeerConnection after transport failure", async () => {
    const errors: Array<{ code?: string }> = [];
    const runtime: WebRtcRuntime = {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    };

    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: false,
      readiness: "data",
      runtime,
      maxAutoReconnectAttempts: 0,
      onSessionError: (e) => errors.push(e),
    });

    sendOffer(MockWebSocket.instances[0]!);
    await Promise.resolve();
    await Promise.resolve();

    expect(MockPeerConnection.instances).toHaveLength(1);
    MockPeerConnection.instances[0]!.failConnection();
    await Promise.resolve();
    await Promise.resolve();

    // No automatic PC reconstruction — still a single peer instance.
    expect(MockPeerConnection.instances).toHaveLength(1);
    expect(errors.some((e) => e.code === "WEBRTC_CONNECTION_FAILED")).toBe(
      true,
    );
    session.disconnect();
  });

  it("does not auto-reconnect after graceful disconnect()", async () => {
    const reconnecting = vi.fn();
    const runtime: WebRtcRuntime = {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    };

    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: false,
      readiness: "data",
      runtime,
      maxAutoReconnectAttempts: 2,
      onReconnecting: reconnecting,
    });

    sendOffer(MockWebSocket.instances[0]!);
    await Promise.resolve();
    await Promise.resolve();
    openDataChannels(MockPeerConnection.instances[0]!);
    await session.waitForConnected(1_000);

    const wsCountBefore = MockWebSocket.instances.length;
    session.disconnect();
    MockPeerConnection.instances[0]!.failConnection();
    await Promise.resolve();

    expect(reconnecting).not.toHaveBeenCalled();
    expect(MockWebSocket.instances.length).toBe(wsCountBefore);
  });

  it("disconnectAsync awaits Node closeAsync; rejection is diagnostic-only", async () => {
    MockPeerConnection.useCloseAsync = true;
    MockPeerConnection.closeAsyncReject = true;
    const diagnostics: VoiceSessionDiagnosticEvent[] = [];
    const runtime: WebRtcRuntime = {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    };

    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: false,
      readiness: "data",
      runtime,
      iceTransportPolicy: "relay",
      onDiagnosticEvent: (e) => diagnostics.push(e),
    });

    sendOffer(MockWebSocket.instances[0]!);
    await Promise.resolve();
    await Promise.resolve();
    expect(MockPeerConnection.instances[0]!.config?.iceTransportPolicy).toBe(
      "relay",
    );
    openDataChannels(MockPeerConnection.instances[0]!);
    await session.waitForConnected(1_000);

    await session.disconnectAsync();
    await session.disconnectAsync();
    expect(MockPeerConnection.closeAsyncCalls).toBe(1);
    expect(MockPeerConnection.instances[0]!.closeCalls).toBe(0);
    expect(diagnostics.some((d) => d.type === "peer_close" && d.error)).toBe(
      true,
    );
    expect(session.getConnectionStatus().peerConnectionState).toBe("closed");
  });

  it("explicit reconnect() still works after a failed transport", async () => {
    const runtime: WebRtcRuntime = {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    };

    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: false,
      readiness: "data",
      runtime,
      maxAutoReconnectAttempts: 0,
    });

    sendOffer(MockWebSocket.instances[0]!);
    await Promise.resolve();
    await Promise.resolve();
    openDataChannels(MockPeerConnection.instances[0]!);
    await session.waitForConnected(1_000);

    const wsBefore = MockWebSocket.instances.length;
    await session.reconnect();
    expect(MockWebSocket.instances.length).toBeGreaterThan(wsBefore);
    session.disconnect();
  });

  it("exports CLIENT_CAPABILITIES.iceTransportPolicy", () => {
    expect(CLIENT_CAPABILITIES.iceTransportPolicy).toBe(true);
  });

  it("disconnect() is synchronous (returns void, not a Promise)", async () => {
    const runtime: WebRtcRuntime = {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    };
    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: false,
      readiness: "data",
      runtime,
    });
    const result = session.disconnect();
    expect(result).toBeUndefined();
  });
});
