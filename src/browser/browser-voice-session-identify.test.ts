import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectBrowserVoiceSession,
  VOICE_AGENT_SERVER_PEER_ID,
} from "./browser-voice-session.js";
import {
  EndUserConflictError,
  EndUserRejectedError,
} from "./end-user-identity.js";
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
  static createAnswerGate: Promise<void> | null = null;
  static createAnswerCalls = 0;

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
    MockPeerConnection.createAnswerCalls += 1;
    if (MockPeerConnection.createAnswerGate) {
      await MockPeerConnection.createAnswerGate;
    }
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

/** Simulates nwr: setLocalDescription snapshots SDP before gather; gatheringComplete refreshes it. */
class WaitGatheringMockPeerConnection extends MockPeerConnection {
  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = description;
    this.iceGatheringState = "gathering";
  }

  async gatheringComplete(): Promise<void> {
    await Promise.resolve();
    const baseSdp =
      typeof this.localDescription?.sdp === "string"
        ? this.localDescription.sdp
        : "";
    this.localDescription = {
      type: this.localDescription?.type ?? "answer",
      sdp: `${baseSdp}a=candidate:1 1 UDP 2130706431 10.0.0.1 3478 typ relay\r\n`,
    };
    this.iceGatheringState = "complete";
    this.onicegatheringstatechange?.();
  }
}

function mockRuntime(overrides: Partial<WebRtcRuntime> = {}): WebRtcRuntime {
  return {
    WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
    RTCPeerConnection:
      MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    ...overrides,
  };
}

function mockWaitGatheringRuntime(): WebRtcRuntime {
  return mockRuntime({
    iceAnswerPolicy: "wait-gathering",
    RTCPeerConnection:
      WaitGatheringMockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
  });
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

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function connectWithControl(
  extra: Partial<Parameters<typeof connectBrowserVoiceSession>[0]> = {},
) {
  const session = await connectBrowserVoiceSession({
    credentials: {
      ...baseCredentials,
      session_id: "orch-9",
      join_token: "jt-9",
    },
    requestMic: false,
    readiness: "data",
    runtime: mockRuntime(),
    reconnectPolicy: "new-session",
    apiBase: "https://sessions.example/v1/",
    projectId: "proj-1",
    apiHeaders: { Authorization: "Bearer k" },
    ...extra,
  });
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
  ws.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      peerId: VOICE_AGENT_SERVER_PEER_ID,
      sdp: { type: "offer", sdp: "v=0\r\na=ice-ufrag:server\r\n" },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sent: string[] = [];
  const channel = {
    label: "voice-control",
    readyState: "open",
    bufferedAmount: 0,
    send: (data: string) => sent.push(data),
    close: () => {},
  } as unknown as RTCDataChannel;
  const pc =
    MockPeerConnection.instances[MockPeerConnection.instances.length - 1]!;
  pc.ondatachannel?.({ channel } as RTCDataChannelEvent);
  channel.onopen?.(new Event("open"));
  return { session, sent, channel };
}

describe("identify and logout", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockPeerConnection.instances = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("posts the join token to the orchestrator session and nudges the agent after 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        end_user: { id: "u-1", verified: true },
        result: "updated",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { session, sent } = await connectWithControl();

    const result = await session.identify({ endUserToken: "tok" });

    expect(result).toEqual({ id: "u-1", verified: true, result: "updated" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://sessions.example/v1/sessions/orch-9/end-user");
    expect(JSON.parse(init.body)).toEqual({
      project_id: "proj-1",
      join_token: "jt-9",
      end_user_token: "tok",
    });
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(sent.map((f) => JSON.parse(f))).toContainEqual({
      type: "session_identity_refresh",
    });
  });

  it("409 end_user_conflict throws EndUserConflictError, calls the callback and sends no nudge", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(409, { error: { code: "end_user_conflict" } }),
        ),
    );
    const onIdentityConflict = vi.fn();
    const { session, sent } = await connectWithControl({ onIdentityConflict });

    const error = await session
      .identify({ endUser: { id: "u-2" } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EndUserConflictError);
    expect(onIdentityConflict).toHaveBeenCalledTimes(1);
    expect(sent.map((f) => JSON.parse(f).type)).not.toContain(
      "session_identity_refresh",
    );
  });

  it("401 maps to EndUserRejectedError", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(401, { error: { code: "end_user_rejected" } }),
        ),
    );
    const { session } = await connectWithControl();
    await expect(
      session.identify({ endUserToken: "bad" }),
    ).rejects.toBeInstanceOf(EndUserRejectedError);
  });

  it("503 is a retryable EndUserAuthUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(503, { error: { code: "end_user_auth_unavailable" } }),
        ),
    );
    const { session } = await connectWithControl();
    const error = (await session
      .identify({ endUserToken: "t" })
      .catch((e: unknown) => e)) as { name: string; retryable: boolean };
    expect(error.name).toBe("EndUserAuthUnavailableError");
    expect(error.retryable).toBe(true);
  });

  it("identify sends the start join token after a session_reconnect_token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        end_user: { id: "u-1", verified: true },
        result: "unchanged",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { session, channel } = await connectWithControl();
    channel.onmessage?.({
      data: JSON.stringify({
        type: "session_reconnect_token",
        token: "rt-2",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    } as MessageEvent);

    await session.identify({ endUserToken: "tok" });

    const init = fetchMock.mock.calls[0]![1];
    expect(JSON.parse(init.body).join_token).toBe("jt-9");
  });

  it("identify without apiBase/projectId throws TypeError and makes no request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { session } = await connectWithControl({
      apiBase: undefined,
      projectId: undefined,
    });
    await expect(
      session.identify({ endUserToken: "t" }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logout sends session_close with reason end_user_logout and closes the session", async () => {
    const { session, sent } = await connectWithControl();
    const result = await session.logout();
    expect(sent.map((f) => JSON.parse(f))).toContainEqual({
      type: "session_close",
      reason: "end_user_logout",
    });
    expect(result.status).toBe("closed");
  });
});
