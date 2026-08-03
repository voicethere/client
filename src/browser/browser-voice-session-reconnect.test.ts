import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionErrorEvent } from "../session-errors.js";
import {
  connectBrowserVoiceSession,
  VOICE_AGENT_SERVER_PEER_ID,
  VOICE_CONTROL_CHANNEL_LABEL,
  VOICE_SYNC_CHANNEL_LABEL,
} from "./browser-voice-session.js";
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

type MockPeerOptions = {
  failOnConnect?: boolean;
};

class MockPeerConnection {
  static instances: MockPeerConnection[] = [];
  static nextOptions: MockPeerOptions = {};

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

  readonly options: MockPeerOptions;

  constructor(_config?: RTCConfiguration) {
    this.options = { ...MockPeerConnection.nextOptions };
    MockPeerConnection.instances.push(this);
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
    return { type: "answer", sdp: "v=0\r\na=ice-ufrag:local\r\n" };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = description;
    this.iceGatheringState = "complete";
    this.onicegatheringstatechange?.();
  }

  connect(): void {
    if (this.options.failOnConnect) {
      this.connectionState = "failed";
      this.onconnectionstatechange?.();
      return;
    }
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
  }

  fail(): void {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }

  close(): void {
    this.connectionState = "closed";
  }
}

function sendOffer(ws: MockWebSocket): void {
  ws.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      peerId: VOICE_AGENT_SERVER_PEER_ID,
      sdp: {
        type: "offer",
        sdp: "v=0\r\na=ice-ufrag:server\r\na=ice-pwd:secret\r\n",
      },
    }),
  });
}

function openDataChannels(pc: MockPeerConnection): MockDataChannel {
  const control = new MockDataChannel(VOICE_CONTROL_CHANNEL_LABEL);
  const sync = new MockDataChannel(VOICE_SYNC_CHANNEL_LABEL);
  pc.ondatachannel?.({ channel: control } as RTCDataChannelEvent);
  pc.ondatachannel?.({ channel: sync } as RTCDataChannelEvent);
  pc.connect();
  control.open();
  sync.open();
  return control;
}

const credentials = {
  session_id: "session-1",
  mode: "data" as const,
  room_id: "room-1",
  join_token: "join",
  signaling_url: "ws://127.0.0.1:8080/ws",
  ice_servers: [],
  expires_at: new Date(Date.now() + 60_000).toISOString(),
};

describe("connectBrowserVoiceSession ICE reconnect", () => {
  afterEach(() => {
    vi.useRealTimers();
    MockWebSocket.instances = [];
    MockPeerConnection.instances = [];
    MockPeerConnection.nextOptions = {};
  });

  it("waitForConnected survives a retriable WebRTC failure and reconnects on the same session", async () => {
    vi.useFakeTimers();

    const runtime: WebRtcRuntime = {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    };

    const reconnectingAttempts: number[] = [];
    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: false,
      readiness: "data",
      runtime,
      maxAutoReconnectAttempts: 2,
      onReconnecting: (attempt) => reconnectingAttempts.push(attempt),
    });

    const firstWs = MockWebSocket.instances[0];
    sendOffer(firstWs);
    await Promise.resolve();
    await Promise.resolve();

    const pending = session.waitForConnected(10_000);

    const firstPc = MockPeerConnection.instances[0];
    firstPc.fail();
    await Promise.resolve();

    MockPeerConnection.nextOptions = { failOnConnect: false };

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    const secondWs = MockWebSocket.instances.at(-1);
    expect(secondWs).toBeDefined();
    expect(secondWs).not.toBe(firstWs);
    sendOffer(secondWs!);
    await Promise.resolve();
    await Promise.resolve();

    const secondPc = MockPeerConnection.instances.at(-1);
    openDataChannels(secondPc!);

    await pending;
    expect(session.getConnectionStatus().ready).toBe(true);
    expect(reconnectingAttempts).toEqual([1]);
  });

  it("onReconnected fires after same-session reconnect reaches ready, not on initial connect", async () => {
    vi.useFakeTimers();

    const runtime: WebRtcRuntime = {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    };

    const reconnectedAttempts: number[] = [];
    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: false,
      readiness: "data",
      runtime,
      maxAutoReconnectAttempts: 2,
      onReconnected: (attempt) => reconnectedAttempts.push(attempt),
    });

    sendOffer(MockWebSocket.instances[0]);
    await Promise.resolve();
    await Promise.resolve();
    openDataChannels(MockPeerConnection.instances[0]);
    await session.waitForConnected(1_000);
    expect(reconnectedAttempts).toEqual([]);

    const pending = session.waitForConnected(10_000);
    MockPeerConnection.instances[0].fail();
    await Promise.resolve();
    MockPeerConnection.nextOptions = { failOnConnect: false };

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    sendOffer(MockWebSocket.instances.at(-1)!);
    await Promise.resolve();
    await Promise.resolve();
    openDataChannels(MockPeerConnection.instances.at(-1)!);

    await pending;
    expect(reconnectedAttempts).toEqual([1]);
  });

  it("onReconnected fires after manual reconnect()", async () => {
    const runtime: WebRtcRuntime = {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    };

    const reconnectedAttempts: number[] = [];
    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: false,
      readiness: "data",
      runtime,
      onReconnected: (attempt) => reconnectedAttempts.push(attempt),
    });

    sendOffer(MockWebSocket.instances[0]);
    await Promise.resolve();
    await Promise.resolve();
    openDataChannels(MockPeerConnection.instances[0]);
    await session.waitForConnected(1_000);
    expect(reconnectedAttempts).toEqual([]);

    await session.reconnect();
    await Promise.resolve();

    sendOffer(MockWebSocket.instances.at(-1)!);
    await Promise.resolve();
    await Promise.resolve();
    openDataChannels(MockPeerConnection.instances.at(-1)!);
    await session.waitForConnected(1_000);

    expect(reconnectedAttempts).toEqual([0]);
  });

  it("waitForConnected rejects immediately when maxAutoReconnectAttempts is 0", async () => {
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

    sendOffer(MockWebSocket.instances[0]);
    await Promise.resolve();
    await Promise.resolve();

    const pending = session.waitForConnected(1_000);
    MockPeerConnection.instances[0].fail();
    await Promise.resolve();

    await expect(pending).rejects.toThrow("peer connection failed");
  });

  it("emits WEBRTC_RECONNECT_EXHAUSTED when auto-reconnect budget is spent", async () => {
    vi.useFakeTimers();

    const sessionErrors: SessionErrorEvent[] = [];
    const reconnectingAttempts: number[] = [];
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
      maxAutoReconnectAttempts: 1,
      onReconnecting: (attempt) => reconnectingAttempts.push(attempt),
      onSessionError: (event) => sessionErrors.push(event),
    });

    sendOffer(MockWebSocket.instances[0]);
    await Promise.resolve();
    await Promise.resolve();

    MockPeerConnection.instances[0].fail();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    const secondWs = MockWebSocket.instances.at(-1);
    expect(secondWs).toBeDefined();
    sendOffer(secondWs!);
    await Promise.resolve();
    await Promise.resolve();

    MockPeerConnection.instances.at(-1)!.fail();
    await Promise.resolve();

    const exhausted = sessionErrors.find(
      (event) => event.code === "WEBRTC_RECONNECT_EXHAUSTED",
    );
    expect(exhausted).toMatchObject({
      code: "WEBRTC_RECONNECT_EXHAUSTED",
      recoverable: false,
    });
    expect(reconnectingAttempts).toEqual([1]);
    expect(session.getConnectionStatus().ready).toBe(false);
    expect(session.getConnectionStatus().peerConnectionState).toBe("closed");

    const wsCountAfterExhaust = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(8_000);
    await Promise.resolve();
    expect(MockWebSocket.instances.length).toBe(wsCountAfterExhaust);
  });

  it("handles inbound session_close idle kick with SESSION_IDLE_TIMEOUT and no reconnect", async () => {
    vi.useFakeTimers();

    const sessionErrors: SessionErrorEvent[] = [];
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
      onSessionError: (event) => sessionErrors.push(event),
    });

    sendOffer(MockWebSocket.instances[0]);
    await Promise.resolve();
    await Promise.resolve();

    const control = openDataChannels(MockPeerConnection.instances[0]);
    await session.waitForConnected(1_000);
    expect(session.getConnectionStatus().ready).toBe(true);

    control.onmessage?.({
      data: JSON.stringify({
        type: "session_close",
        code: "idle_timeout",
        message: "Peer idle for 300s",
      }),
    });
    await Promise.resolve();

    expect(sessionErrors).toContainEqual(
      expect.objectContaining({
        code: "SESSION_IDLE_TIMEOUT",
        message: "Peer idle for 300s",
        recoverable: false,
      }),
    );
    expect(session.getConnectionStatus().ready).toBe(false);
    expect(session.getConnectionStatus().peerConnectionState).toBe("closed");
    expect(session.getConnectionState()).toBe("closed");

    const wsCountBefore = MockWebSocket.instances.length;
    MockPeerConnection.instances[0].fail();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(8_000);
    await Promise.resolve();

    expect(reconnecting).not.toHaveBeenCalled();
    expect(MockWebSocket.instances.length).toBe(wsCountBefore);
  });

  it("updates join token from session_reconnect_token and uses it on explicit reconnect", async () => {
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

    sendOffer(MockWebSocket.instances[0]);
    await Promise.resolve();
    await Promise.resolve();

    const control = openDataChannels(MockPeerConnection.instances[0]);
    await session.waitForConnected(1_000);

    control.onmessage?.({
      data: JSON.stringify({
        type: "session_reconnect_token",
        token: "opaque-reconnect-token",
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      }),
    });
    await Promise.resolve();

    const wsCountBeforeReconnect = MockWebSocket.instances.length;
    await session.reconnect();
    await Promise.resolve();

    const reconnectWs = MockWebSocket.instances.at(-1);
    expect(MockWebSocket.instances.length).toBe(wsCountBeforeReconnect + 1);
    expect(reconnectWs?.url).toContain("token=opaque-reconnect-token");
    expect(reconnectWs?.url).not.toContain("token=join");
  });

  it("ignores session_reconnect_token with empty token", async () => {
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

    sendOffer(MockWebSocket.instances[0]);
    await Promise.resolve();
    await Promise.resolve();

    const control = openDataChannels(MockPeerConnection.instances[0]);
    await session.waitForConnected(1_000);

    control.onmessage?.({
      data: JSON.stringify({
        type: "session_reconnect_token",
        token: "   ",
      }),
    });
    await Promise.resolve();

    await session.reconnect();
    await Promise.resolve();

    const reconnectWs = MockWebSocket.instances.at(-1);
    expect(reconnectWs?.url).toContain("token=join");
  });

  it("forceCloseSignalingForTests auto-reconnects with updated join token", async () => {
    vi.useFakeTimers();

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
    });

    sendOffer(MockWebSocket.instances[0]);
    await Promise.resolve();
    await Promise.resolve();

    const control = openDataChannels(MockPeerConnection.instances[0]);
    await session.waitForConnected(1_000);

    control.onmessage?.({
      data: JSON.stringify({
        type: "session_reconnect_token",
        token: "opaque-after-ws-close",
      }),
    });
    await Promise.resolve();

    const firstWs = MockWebSocket.instances[0];
    const wsCountBefore = MockWebSocket.instances.length;
    session.forceCloseSignalingForTests();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(MockWebSocket.instances.length).toBe(wsCountBefore + 1);
    const secondWs = MockWebSocket.instances.at(-1);
    expect(secondWs).not.toBe(firstWs);
    expect(secondWs?.url).toContain("token=opaque-after-ws-close");
  });
});
