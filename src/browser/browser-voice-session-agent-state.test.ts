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

  readonly config: RTCConfiguration | undefined;
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

  constructor(config?: RTCConfiguration) {
    this.config = config;
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

describe("connectBrowserVoiceSession agent state events", () => {
  afterEach(() => {
    MockWebSocket.instances = [];
    MockPeerConnection.instances = [];
    MockPeerConnection.nextOptions = {};
  });

  const runtime = (): WebRtcRuntime => ({
    WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
    RTCPeerConnection:
      MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
  });

  const connect = async (
    extra: Partial<Parameters<typeof connectBrowserVoiceSession>[0]>,
  ) => {
    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: false,
      readiness: "data",
      runtime: runtime(),
      ...extra,
    });
    sendOffer(MockWebSocket.instances[0]);
    await Promise.resolve();
    await Promise.resolve();
    const control = openDataChannels(MockPeerConnection.instances[0]);
    await session.waitForConnected(1_000);
    return control;
  };

  it("agent_state on voice-control calls onAgentState and still calls onControlMessage", async () => {
    const onAgentState = vi.fn();
    const onControlMessage = vi.fn();
    const control = await connect({ onAgentState, onControlMessage });
    const message = { type: "agent_state", state: "thinking", detail: "x" };
    control.onmessage?.({ data: JSON.stringify(message) });
    expect(onAgentState).toHaveBeenCalledWith({
      state: "thinking",
      detail: "x",
    });
    expect(onControlMessage).toHaveBeenCalledWith(message);
  });

  it("a throwing onAgentState callback does not stop later control messages", async () => {
    const onAgentState = vi.fn(() => {
      throw new Error("customer bug");
    });
    const onControlMessage = vi.fn();
    const control = await connect({ onAgentState, onControlMessage });
    control.onmessage?.({
      data: JSON.stringify({ type: "agent_state", state: "speaking" }),
    });
    control.onmessage?.({ data: JSON.stringify({ type: "later", n: 2 }) });
    expect(onAgentState).toHaveBeenCalledTimes(1);
    expect(onControlMessage).toHaveBeenCalledWith({ type: "later", n: 2 });
  });

  it("agent_interrupted on voice-control calls onAgentInterrupted", async () => {
    const onAgentInterrupted = vi.fn();
    const control = await connect({ onAgentInterrupted });
    control.onmessage?.({
      data: JSON.stringify({
        type: "agent_interrupted",
        turnId: "t1",
        replyPlayedMs: 800,
        playedTextExact: false,
      }),
    });
    expect(onAgentInterrupted).toHaveBeenCalledWith({
      turnId: "t1",
      replyPlayedMs: 800,
      playedTextExact: false,
    });
  });
});
