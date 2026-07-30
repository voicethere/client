import { afterEach, describe, expect, it, vi } from "vitest";

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
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
  }

  close(): void {
    this.connectionState = "closed";
  }
}

const credentials = {
  session_id: "session-1",
  mode: "voice" as const,
  room_id: "room-1",
  join_token: "join",
  signaling_url: "ws://127.0.0.1:8080/ws",
  ice_servers: [],
  expires_at: new Date(Date.now() + 60_000).toISOString(),
};

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

async function waitForOfferNegotiation(): Promise<MockPeerConnection> {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
  const pc = MockPeerConnection.instances[0];
  if (!pc?.localDescription) {
    throw new Error("offer negotiation did not complete");
  }
  return pc;
}

function wireDataChannelsWithoutOpening(pc: MockPeerConnection): void {
  pc.ondatachannel?.({
    channel: new MockDataChannel(VOICE_CONTROL_CHANNEL_LABEL),
  } as RTCDataChannelEvent);
  pc.ondatachannel?.({
    channel: new MockDataChannel(VOICE_SYNC_CHANNEL_LABEL),
  } as RTCDataChannelEvent);
}

function wireVoiceMedia(pc: MockPeerConnection): void {
  const mockStream = {
    getAudioTracks: () => [],
    getTracks: () => [],
  };
  pc.ontrack?.({
    track: { kind: "audio", readyState: "live" } as MediaStreamTrack,
    streams: [mockStream as unknown as MediaStream],
  } as RTCTrackEvent);
}

function createMicRuntime(): WebRtcRuntime {
  const track = {
    kind: "audio",
    readyState: "live",
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  return {
    WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
    RTCPeerConnection:
      MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    getUserMedia: async () =>
      ({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      }) as unknown as MediaStream,
  };
}

describe("connectBrowserVoiceSession half-open fail-fast", () => {
  afterEach(() => {
    vi.useRealTimers();
    MockWebSocket.instances = [];
    MockPeerConnection.instances = [];
  });

  it("voice_and_data fails fast when PC is connected but data channels stay closed", async () => {
    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: true,
      readiness: "voice_and_data",
      runtime: createMicRuntime(),
      maxAutoReconnectAttempts: 0,
    });

    sendOffer(MockWebSocket.instances[0]!);
    const pc = await waitForOfferNegotiation();
    wireDataChannelsWithoutOpening(pc);
    wireVoiceMedia(pc);
    pc.connect();
    await Promise.resolve();

    expect(session.getConnectionStatus()).toMatchObject({
      phase: "awaiting_channels",
      peerConnectionState: "connected",
      controlChannelOpen: false,
      syncChannelOpen: false,
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = session.waitForConnected(60_000);

    await vi.advanceTimersByTimeAsync(19_999);
    await Promise.resolve();
    await expect(
      Promise.race([pending, Promise.resolve("still waiting")]),
    ).resolves.toBe("still waiting");

    await vi.advanceTimersByTimeAsync(2);
    try {
      await pending;
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toMatch(/half-open timeout/);
      expect(message).toMatch(/half_open=true/);
      expect(message).toMatch(/phase=awaiting_channels/);
      expect(message).toMatch(/control=false/);
      expect(message).toMatch(/sync=false/);
    }
  });

  it("data profile keeps waiting through half-open window and uses full connect timeout", async () => {
    const session = await connectBrowserVoiceSession({
      credentials: {
        ...credentials,
        mode: "data",
      },
      requestMic: false,
      readiness: "data",
      runtime: {
        WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
        RTCPeerConnection:
          MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
      },
      maxAutoReconnectAttempts: 0,
    });

    sendOffer(MockWebSocket.instances[0]!);
    const pc = await waitForOfferNegotiation();
    wireDataChannelsWithoutOpening(pc);
    pc.connect();
    await Promise.resolve();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = session.waitForConnected(30_000);

    await vi.advanceTimersByTimeAsync(25_000);
    await Promise.resolve();
    await expect(
      Promise.race([pending, Promise.resolve("still waiting")]),
    ).resolves.toBe("still waiting");

    await vi.advanceTimersByTimeAsync(5_001);
    try {
      await pending;
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toMatch(/connect timeout after 30000ms/);
      expect(message).toMatch(/half_open=false/);
      expect(message).not.toMatch(/half-open timeout/);
    }
  });
});
