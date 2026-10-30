import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import type { AgentTextUpdate } from "../spoken-text-reveal.js";

type RuntimeShape = "browser" | "node";

describe.each<RuntimeShape>(["browser", "node"])(
  "connectBrowserVoiceSession onAgentText (%s runtime shape)",
  (shape) => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      MockWebSocket.instances = [];
      MockPeerConnection.instances = [];
      MockPeerConnection.nextOptions = {};
    });

    // The node runtime differs only in the socket/peer implementation and the ICE answer policy;
    // the control-message path under test is shared.
    const runtime = (): WebRtcRuntime => ({
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
      ...(shape === "node"
        ? { iceAnswerPolicy: "wait-gathering" as const }
        : {}),
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
      await vi.advanceTimersByTimeAsync(0);
      const control = openDataChannels(MockPeerConnection.instances[0]);
      await session.waitForConnected(1_000);
      const send = (payload: Record<string, unknown>) =>
        control.onmessage?.({ data: JSON.stringify(payload) });
      return { session, send };
    };
    const spoken = (turnId: string, text: string) => ({
      type: "assistant_delta",
      turnId,
      text,
      spoken: true,
    });
    const speech = (event: string) => ({ type: "speech_event", event });

    it("paces a spoken turn with the audio and still passes every raw message to onControlMessage", async () => {
      const updates: AgentTextUpdate[] = [];
      const onControlMessage = vi.fn();
      const { send } = await connect({
        onAgentText: (u) => updates.push(u),
        onControlMessage,
      });
      send(spoken("A", "One two three."));
      expect(updates).toEqual([]);
      send(speech("agent_speaking_start"));
      expect(updates.map((u) => u.text)).toEqual(["One"]);
      send({
        type: "assistant_done",
        turnId: "A",
        text: "One two three.",
        spoken: true,
        status: "completed",
      });
      await vi.advanceTimersByTimeAsync(330 * 5);
      expect(updates.at(-1)).toEqual({
        turnId: "A",
        text: "One two three.",
        spoken: true,
        final: true,
      });
      expect(onControlMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "assistant_done" }),
      );
      expect(onControlMessage).toHaveBeenCalledWith(
        speech("agent_speaking_start"),
      );
    });

    it('spokenTextReveal "immediate" reports at once', async () => {
      const updates: AgentTextUpdate[] = [];
      const { send } = await connect({
        spokenTextReveal: "immediate",
        onAgentText: (u) => updates.push(u),
      });
      send(spoken("A", "One two three."));
      expect(updates).toEqual([
        { turnId: "A", text: "One two three.", spoken: true, final: false },
      ]);
    });

    it("typed turn is reported once; the trailing chat_reply is not reported", async () => {
      const updates: AgentTextUpdate[] = [];
      const { send } = await connect({ onAgentText: (u) => updates.push(u) });
      send({ type: "assistant_delta", turnId: "T", text: "Hello there." });
      send({ type: "assistant_done", turnId: "T", text: "Hello there." });
      send({ type: "chat_reply", text: "Hello there." });
      expect(updates).toEqual([
        { turnId: "T", text: "Hello there.", spoken: false, final: false },
        { turnId: "T", text: "Hello there.", spoken: false, final: true },
      ]);
    });

    it("closing the session clears reveal timers and reports nothing afterwards", async () => {
      const updates: AgentTextUpdate[] = [];
      const { session, send } = await connect({
        onAgentText: (u) => updates.push(u),
      });
      send(spoken("A", "One two three four five."));
      send(speech("agent_speaking_start"));
      const before = updates.length;
      session.disconnect();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(updates.length).toBe(before);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("without onAgentText nothing is revealed and no timers are started", async () => {
      const { send } = await connect({});
      send(spoken("A", "One two three."));
      send(speech("agent_speaking_start"));
      expect(vi.getTimerCount()).toBe(0);
    });
  },
);
