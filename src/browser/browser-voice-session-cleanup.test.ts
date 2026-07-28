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
  /** When true, constructors fire onerror instead of onopen. */
  static failOpen = false;

  readonly url: string;
  readyState = MockWebSocket.OPEN;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (MockWebSocket.failOpen) {
        this.onerror?.({});
        return;
      }
      this.onopen?.({});
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
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
  onerror: ((event: unknown) => void) | null = null;
  messages: unknown[] = [];

  constructor(label: string) {
    this.label = label;
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.({});
  }

  send(_data: unknown): void {}
  close(): void {
    this.readyState = "closed";
    this.onclose?.({});
  }
}

class MockPeerConnection {
  static instances: MockPeerConnection[] = [];
  static useCloseAsync = false;
  static closeAsyncCalls = 0;
  static closeAsyncReject = false;
  /** When set, closeAsync waits until the returned gate resolves. */
  static closeAsyncGate: Promise<void> | null = null;

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
        if (MockPeerConnection.closeAsyncGate) {
          await MockPeerConnection.closeAsyncGate;
        }
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

  iceCandidates: RTCIceCandidateInit[] = [];

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.iceCandidates.push(candidate);
  }

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

async function sendOffer(ws: MockWebSocket): Promise<void> {
  const before = MockPeerConnection.instances.length;
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
  // Offer negotiation is serialized on a microtask chain — wait for the PC.
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
    if (MockPeerConnection.instances.length > before) break;
  }
  const pc = MockPeerConnection.instances.at(-1);
  if (!pc) return;
  const control = new MockDataChannel(VOICE_CONTROL_CHANNEL_LABEL);
  const sync = new MockDataChannel(VOICE_SYNC_CHANNEL_LABEL);
  pc.ondatachannel?.({
    channel: control,
  } as RTCDataChannelEvent);
  pc.ondatachannel?.({ channel: sync } as RTCDataChannelEvent);
  control.open();
  sync.open();
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
    MockWebSocket.failOpen = false;
    MockPeerConnection.instances = [];
    MockPeerConnection.useCloseAsync = false;
    MockPeerConnection.closeAsyncCalls = 0;
    MockPeerConnection.closeAsyncReject = false;
    MockPeerConnection.closeAsyncGate = null;
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

    await sendOffer(MockWebSocket.instances[0]!);

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

    await sendOffer(MockWebSocket.instances[0]!);
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

    await sendOffer(MockWebSocket.instances[0]!);
    expect(MockPeerConnection.instances[0]!.config?.iceTransportPolicy).toBe(
      "relay",
    );
    openDataChannels(MockPeerConnection.instances[0]!);
    await session.waitForConnected(1_000);

    const first = await session.disconnectAsync();
    const second = await session.disconnectAsync();
    expect(first.status).toBe("failed");
    // Cached terminal result — must not invent `closed` because pc is null.
    expect(second.status).toBe("failed");
    expect(second).toBe(first);
    expect(MockPeerConnection.closeAsyncCalls).toBe(1);
    expect(MockPeerConnection.instances[0]!.closeCalls).toBe(0);
    expect(
      diagnostics.some(
        (d) => d.type === "peer_close" && d.status === "failed" && d.error,
      ),
    ).toBe(true);
    expect(session.getConnectionStatus().peerConnectionState).toBe("closed");
  });

  it("concurrent disconnectAsync shares one in-flight close", async () => {
    MockPeerConnection.useCloseAsync = true;
    let resolveClose: (() => void) | undefined;
    MockPeerConnection.closeAsyncGate = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

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
    await sendOffer(MockWebSocket.instances[0]!);
    openDataChannels(MockPeerConnection.instances[0]!);
    await session.waitForConnected(1_000);

    const a = session.disconnectAsync();
    const b = session.disconnectAsync();
    await Promise.resolve();
    expect(MockPeerConnection.closeAsyncCalls).toBe(1);
    resolveClose?.();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe("closed");
    expect(rb.status).toBe("closed");
    expect(MockPeerConnection.closeAsyncCalls).toBe(1);
  });

  it("sync disconnect during disconnectAsync does not call a second pc.close", async () => {
    MockPeerConnection.useCloseAsync = true;
    let resolveClose: (() => void) | undefined;
    MockPeerConnection.closeAsyncGate = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

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
    await sendOffer(MockWebSocket.instances[0]!);
    openDataChannels(MockPeerConnection.instances[0]!);
    await session.waitForConnected(1_000);

    const pending = session.disconnectAsync();
    await Promise.resolve();
    session.disconnect();
    expect(MockPeerConnection.instances[0]!.closeCalls).toBe(0);
    resolveClose?.();
    const result = await pending;
    expect(result.status).toBe("closed");
    expect(MockPeerConnection.closeAsyncCalls).toBe(1);
  });

  it("waitForConnected success clears timeout timer (fake timers)", async () => {
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
    await sendOffer(MockWebSocket.instances[0]!);
    openDataChannels(MockPeerConnection.instances[0]!);

    vi.useFakeTimers();
    try {
      const waiting = session.waitForConnected(60_000);
      await Promise.resolve();
      await waiting;
      // No leftover timeout should fire after success.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(session.getConnectionStatus().ready).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

    await sendOffer(MockWebSocket.instances[0]!);
    openDataChannels(MockPeerConnection.instances[0]!);
    await session.waitForConnected(1_000);

    const wsBefore = MockWebSocket.instances.length;
    await session.reconnect();
    expect(MockWebSocket.instances.length).toBeGreaterThan(wsBefore);
    session.disconnect();
  });

  it("repeated failed disconnectAsync returns cached terminal result", async () => {
    MockPeerConnection.useCloseAsync = true;
    MockPeerConnection.closeAsyncReject = true;
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
    await sendOffer(MockWebSocket.instances[0]!);
    const first = await session.disconnectAsync();
    const second = await session.disconnectAsync();
    const third = await session.disconnectAsync();
    expect(first.status).toBe("failed");
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(MockPeerConnection.closeAsyncCalls).toBe(1);
  });

  it("sync disconnect first records sync terminal without later async claim", async () => {
    MockPeerConnection.useCloseAsync = true;
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
    await sendOffer(MockWebSocket.instances[0]!);
    session.disconnect();
    const result = await session.disconnectAsync();
    expect(result.mode).toBe("sync");
    expect(result.status).toBe("closed");
    expect(MockPeerConnection.closeAsyncCalls).toBe(0);
  });

  it("stale PC callbacks do not mutate the live peer after replacement", async () => {
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
    await sendOffer(MockWebSocket.instances[0]!);
    const oldPc = MockPeerConnection.instances[0]!;
    openDataChannels(oldPc);
    await session.waitForConnected(1_000);

    await sendOffer(MockWebSocket.instances[0]!);
    const livePc = MockPeerConnection.instances.at(-1)!;
    expect(livePc).not.toBe(oldPc);
    openDataChannels(livePc);

    oldPc.failConnection();
    await Promise.resolve();
    expect(session.getConnectionState()).toBe("connected");
    expect(livePc.connectionState).toBe("connected");
    session.disconnect();
  });

  it("does not apply ICE candidates after generation change", async () => {
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
    const ws = MockWebSocket.instances[0]!;
    await sendOffer(ws);
    const firstPc = MockPeerConnection.instances[0]!;
    openDataChannels(firstPc);

    // Bump generation via a second offer before applying ICE to the old peer.
    await sendOffer(ws);
    const secondPc = MockPeerConnection.instances.at(-1)!;
    expect(secondPc).not.toBe(firstPc);

    ws.onmessage?.({
      data: JSON.stringify({
        type: "ice-candidate",
        peerId: VOICE_AGENT_SERVER_PEER_ID,
        candidate: { candidate: "candidate:stale", sdpMid: "0" },
      }),
    });
    await Promise.resolve();
    expect(firstPc.iceCandidates).toHaveLength(0);
    session.disconnect();
  });

  it("close failure prevents peer replacement on newer offer", async () => {
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
      maxAutoReconnectAttempts: 0,
      onDiagnosticEvent: (e) => diagnostics.push(e),
    });
    const ws = MockWebSocket.instances[0]!;
    await sendOffer(ws);
    expect(MockPeerConnection.instances).toHaveLength(1);

    await sendOffer(ws);
    // Replacement must not create a second overlapping peer after close failure.
    expect(MockPeerConnection.instances).toHaveLength(1);
    expect(
      diagnostics.some(
        (d) => d.type === "peer_close" && d.context === "offer_replace",
      ),
    ).toBe(true);
    session.disconnect();
  });

  it("concurrent reconnectSignaling is true single-flight (one new WS)", async () => {
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
    await sendOffer(MockWebSocket.instances[0]!);
    openDataChannels(MockPeerConnection.instances[0]!);
    await session.waitForConnected(1_000);

    const before = MockWebSocket.instances.length;
    await Promise.all([
      session.reconnect(),
      session.reconnect(),
      session.reconnect(),
    ]);
    expect(MockWebSocket.instances.length).toBe(before + 1);
    session.disconnect();
  });

  it("queues ICE between offer enqueue and PC create for the new generation", async () => {
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
    const ws = MockWebSocket.instances[0]!;
    const before = MockPeerConnection.instances.length;
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
    // Exact window: offer enqueued, PC not yet created.
    expect(MockPeerConnection.instances.length).toBe(before);
    ws.onmessage?.({
      data: JSON.stringify({
        type: "ice-candidate",
        peerId: VOICE_AGENT_SERVER_PEER_ID,
        candidate: { candidate: "candidate:early", sdpMid: "0" },
      }),
    });
    for (let i = 0; i < 30; i += 1) {
      await Promise.resolve();
      if (MockPeerConnection.instances.length > before) break;
    }
    const pc = MockPeerConnection.instances.at(-1)!;
    await Promise.resolve();
    await Promise.resolve();
    expect(pc.iceCandidates.some((c) => c.candidate === "candidate:early")).toBe(
      true,
    );
    session.disconnect();
  });

  it("ignores stale data-channel open/close/message after PC replacement", async () => {
    const syncBinary: ArrayBuffer[] = [];
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
      onSyncBinaryMessage: (data) => syncBinary.push(data),
    });
    await sendOffer(MockWebSocket.instances[0]!);
    const oldPc = MockPeerConnection.instances[0]!;
    const oldControl = new MockDataChannel(VOICE_CONTROL_CHANNEL_LABEL);
    const oldSync = new MockDataChannel(VOICE_SYNC_CHANNEL_LABEL);
    oldPc.ondatachannel?.({ channel: oldControl } as RTCDataChannelEvent);
    oldPc.ondatachannel?.({ channel: oldSync } as RTCDataChannelEvent);
    oldControl.open();
    oldSync.open();
    openDataChannels(oldPc);
    await session.waitForConnected(1_000);

    await sendOffer(MockWebSocket.instances[0]!);
    const livePc = MockPeerConnection.instances.at(-1)!;
    const liveControl = new MockDataChannel(VOICE_CONTROL_CHANNEL_LABEL);
    const liveSync = new MockDataChannel(VOICE_SYNC_CHANNEL_LABEL);
    livePc.ondatachannel?.({ channel: liveControl } as RTCDataChannelEvent);
    livePc.ondatachannel?.({ channel: liveSync } as RTCDataChannelEvent);
    liveControl.open();
    liveSync.open();

    oldSync.onmessage?.({ data: new Uint8Array([9]).buffer });
    oldControl.onclose?.({});
    oldSync.onclose?.({});
    await Promise.resolve();

    expect(syncBinary).toHaveLength(0);
    expect(session.getConnectionStatus().controlChannelOpen).toBe(true);
    expect(session.getConnectionStatus().syncChannelOpen).toBe(true);
    session.disconnect();
  });

  it("second reconnect after close timeout creates zero replacement PCs", async () => {
    MockPeerConnection.useCloseAsync = true;
    MockPeerConnection.closeAsyncGate = new Promise<void>(() => {
      /* never resolves → timed_out */
    });
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
    await sendOffer(MockWebSocket.instances[0]!);
    openDataChannels(MockPeerConnection.instances[0]!);
    await session.waitForConnected(1_000);
    const pcsBefore = MockPeerConnection.instances.length;

    vi.useFakeTimers();
    try {
      const first = session.reconnect();
      const firstSettled = expect(first).rejects.toThrow(
        /reconnect blocked|timed_out|close/,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await firstSettled;
      await expect(session.reconnect()).rejects.toThrow(/blocked/);
      expect(MockPeerConnection.instances.length).toBe(pcsBefore);
      const disconnectResult = await session.disconnectAsync();
      expect(disconnectResult.status).toBe("timed_out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("initial signaling join failure closes WS and stops mic tracks", async () => {
    MockWebSocket.failOpen = true;
    const stop = vi.fn();
    const track = {
      kind: "audio",
      readyState: "live",
      stop,
    } as unknown as MediaStreamTrack;
    const runtime: WebRtcRuntime = {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
      getUserMedia: async () =>
        ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        }) as unknown as MediaStream,
    };

    await expect(
      connectBrowserVoiceSession({
        credentials,
        requestMic: true,
        readiness: "data",
        runtime,
      }),
    ).rejects.toThrow(/WebSocket error/);

    expect(MockWebSocket.instances[0]!.closeCalls).toBeGreaterThan(0);
    expect(stop).toHaveBeenCalled();
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
