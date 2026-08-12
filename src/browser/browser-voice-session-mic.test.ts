import { describe, expect, it, vi } from "vitest";

import {
  connectBrowserVoiceSession,
  VOICE_AGENT_SERVER_PEER_ID,
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

class MockRtpSender {
  track: MediaStreamTrack | null = null;
  replaceTrack = vi.fn(async (track: MediaStreamTrack | null) => {
    this.track = track;
  });
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
  readonly senders: MockRtpSender[] = [];

  constructor(_config?: RTCConfiguration) {
    MockPeerConnection.instances.push(this);
  }

  addTrack(track: MediaStreamTrack): MockRtpSender {
    const sender = new MockRtpSender();
    sender.track = track;
    this.senders.push(sender);
    return sender;
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

  close(): void {
    this.connectionState = "closed";
  }
}

const credentials = {
  session_id: "s",
  mode: "voice" as const,
  room_id: "r",
  join_token: "j",
  signaling_url: "ws://127.0.0.1:8080/ws",
  ice_servers: [],
  expires_at: new Date(Date.now() + 60_000).toISOString(),
};

function createDeniedMicRuntime(): WebRtcRuntime {
  return {
    WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
    RTCPeerConnection:
      MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    getUserMedia: async () => {
      throw new DOMException("denied", "NotAllowedError");
    },
  };
}

function createLiveMicRuntime(deviceId = "mic-1"): {
  runtime: WebRtcRuntime;
  track: MediaStreamTrack;
  replaceTrack: ReturnType<typeof vi.fn>;
} {
  const track = {
    kind: "audio",
    readyState: "live",
    stop: vi.fn(),
    getSettings: () => ({ deviceId }),
  } as unknown as MediaStreamTrack;
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return {
    runtime: {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
      getUserMedia: async () => stream,
    },
    track,
    replaceTrack: vi.fn(),
  };
}

describe("connectBrowserVoiceSession microphone APIs", () => {
  it("connects with synthetic outbound audio when getUserMedia is denied", async () => {
    MockWebSocket.instances = [];
    MockPeerConnection.instances = [];

    const debugEvents: Array<[string, string]> = [];
    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: true,
      readiness: "data",
      runtime: createDeniedMicRuntime(),
      onDebugEvent: {
        info: (scope, event) => {
          debugEvents.push([scope, event]);
        },
        warn: () => undefined,
        debug: () => undefined,
      },
    });

    expect(session.getAudioInputState()).toBe("denied");
    const mic = session.getMicStream();
    expect(mic).not.toBeNull();
    expect(
      mic!.getAudioTracks().some((track) => track.readyState === "live"),
    ).toBe(true);
    expect(debugEvents).toContainEqual(["voice", "mic_denied"]);
    expect(debugEvents).toContainEqual(["voice", "mic_synthetic_fallback"]);
  });

  it("setAudioInputDevice calls replaceTrack on the outbound sender", async () => {
    MockWebSocket.instances = [];
    MockPeerConnection.instances = [];

    const first = createLiveMicRuntime("mic-a");
    const secondTrack = {
      kind: "audio",
      readyState: "live",
      stop: vi.fn(),
      getSettings: () => ({ deviceId: "mic-b" }),
    } as unknown as MediaStreamTrack;
    const secondStream = {
      getAudioTracks: () => [secondTrack],
      getTracks: () => [secondTrack],
    } as unknown as MediaStream;

    let gumCalls = 0;
    const runtime: WebRtcRuntime = {
      ...first.runtime,
      getUserMedia: async () => {
        gumCalls += 1;
        return gumCalls === 1
          ? ({
              getAudioTracks: () => [first.track],
              getTracks: () => [first.track],
            } as unknown as MediaStream)
          : secondStream;
      },
    };

    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: true,
      readiness: "data",
      runtime,
    });

    const ws = MockWebSocket.instances[0]!;
    ws.onmessage?.({
      data: JSON.stringify({
        type: "offer",
        peerId: VOICE_AGENT_SERVER_PEER_ID,
        sdp: { type: "offer", sdp: "v=0\na=ice-ufrag:abc\n" },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pc = MockPeerConnection.instances[0]!;
    expect(pc.senders.length).toBeGreaterThan(0);

    await session.setAudioInputDevice("mic-b");
    expect(pc.senders[0]!.replaceTrack).toHaveBeenCalledWith(secondTrack);
    expect(session.getAudioInputState()).toBe("live");
    expect(session.getAudioInputDeviceId()).toBe("mic-b");
  });

  it("requestAudioInputAccess returns true on grant and false when still denied", async () => {
    MockWebSocket.instances = [];
    MockPeerConnection.instances = [];

    let allowMic = false;
    const liveTrack = {
      kind: "audio",
      readyState: "live",
      stop: vi.fn(),
      getSettings: () => ({ deviceId: "granted-mic" }),
    } as unknown as MediaStreamTrack;
    const runtime: WebRtcRuntime = {
      WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
      RTCPeerConnection:
        MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
      getUserMedia: async () => {
        if (!allowMic) {
          throw new DOMException("denied", "NotAllowedError");
        }
        return {
          getAudioTracks: () => [liveTrack],
          getTracks: () => [liveTrack],
        } as unknown as MediaStream;
      },
    };

    const session = await connectBrowserVoiceSession({
      credentials,
      requestMic: true,
      readiness: "data",
      runtime,
    });
    expect(session.getAudioInputState()).toBe("denied");

    const deniedAgain = await session.requestAudioInputAccess();
    expect(deniedAgain).toBe(false);
    expect(session.getAudioInputState()).toBe("denied");

    allowMic = true;
    const ws = MockWebSocket.instances[0]!;
    ws.onmessage?.({
      data: JSON.stringify({
        type: "offer",
        peerId: VOICE_AGENT_SERVER_PEER_ID,
        sdp: { type: "offer", sdp: "v=0\na=ice-ufrag:abc\n" },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const granted = await session.requestAudioInputAccess();
    expect(granted).toBe(true);
    expect(session.getAudioInputState()).toBe("live");
    expect(session.getAudioInputDeviceId()).toBe("granted-mic");
  });
});
