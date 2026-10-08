import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

import type { SessionErrorEvent } from "../session-errors.js";
import { NodeWebSocketAdapter } from "../node/node-websocket.js";
import type { WebRtcConnectionStatus } from "./webrtc-connection-status.js";
import {
  CLIENT_HANGUP_MESSAGE_TYPE,
  connectBrowserVoiceSession,
  VOICE_AGENT_SERVER_PEER_ID,
  VOICE_CONTROL_CHANNEL_LABEL,
  VOICE_SYNC_CHANNEL_LABEL,
  type VoiceSessionReconnectInfo,
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

  /** `error` makes new sockets fail before open (like an unreachable gateway). */
  static mode: "open" | "error" = "open";

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    if (MockWebSocket.mode === "error") {
      queueMicrotask(() => {
        this.onerror?.({});
        this.onclose?.({ code: 1006, reason: "", wasClean: false });
      });
      return;
    }
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

  sent: string[] = [];
  bufferedAmount = 0;
  send(data: unknown): void {
    this.sent.push(String(data));
  }
  close(): void {
    this.readyState = "closed";
  }
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

  /** Candidate-pair states returned by getStats; null = getStats has no pairs. */
  pairStates: RTCStatsIceCandidatePairState[] | null = null;

  async getStats(): Promise<RTCStatsReport> {
    const map = new Map<string, Record<string, unknown>>();
    (this.pairStates ?? []).forEach((state, i) => {
      map.set(`pair-${i}`, {
        id: `pair-${i}`,
        type: "candidate-pair",
        state,
        nominated: false,
      });
    });
    return map as unknown as RTCStatsReport;
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

const openedControlChannels: MockDataChannel[] = [];

function openDataChannels(pc: MockPeerConnection): MockDataChannel {
  const control = new MockDataChannel(VOICE_CONTROL_CHANNEL_LABEL);
  const sync = new MockDataChannel(VOICE_SYNC_CHANNEL_LABEL);
  pc.ondatachannel?.({ channel: control } as RTCDataChannelEvent);
  pc.ondatachannel?.({ channel: sync } as RTCDataChannelEvent);
  pc.connect();
  control.open();
  sync.open();
  openedControlChannels.push(control);
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

const runtime = (): WebRtcRuntime => ({
  WebSocket: MockWebSocket as unknown as WebRtcRuntime["WebSocket"],
  RTCPeerConnection:
    MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
});

function setIce(pc: MockPeerConnection, state: RTCIceConnectionState): void {
  pc.iceConnectionState = state;
  pc.oniceconnectionstatechange?.();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

async function connectReady(
  extra: Partial<Parameters<typeof connectBrowserVoiceSession>[0]> = {},
) {
  const statuses: WebRtcConnectionStatus[] = [];
  const errors: SessionErrorEvent[] = [];
  const debugLines: string[] = [];
  const session = await connectBrowserVoiceSession({
    credentials,
    requestMic: false,
    readiness: "data",
    runtime: runtime(),
    onConnectionStatus: (status) => statuses.push(status),
    onSessionError: (event) => errors.push(event),
    onDebugEvent: {
      info: (s: string, n: string, d?: string) =>
        debugLines.push(`${s}/${n} ${d ?? ""}`),
      warn: (s: string, n: string, d?: string) =>
        debugLines.push(`${s}/${n} ${d ?? ""}`),
      error: (s: string, n: string, d?: string) =>
        debugLines.push(`${s}/${n} ${d ?? ""}`),
      debug: () => undefined,
    } as never,
    ...extra,
  });
  sendOffer(MockWebSocket.instances[0]!);
  await flush();
  openDataChannels(MockPeerConnection.instances[0]!);
  await session.waitForConnected(1_000);
  return { session, statuses, errors, debugLines };
}

/** Deliver a server offer on the newest socket and bring the new PC to ready. */
async function completeReconnect(): Promise<void> {
  sendOffer(MockWebSocket.instances.at(-1)!);
  await flush();
  openDataChannels(MockPeerConnection.instances.at(-1)!);
  await flush();
}

describe("connectBrowserVoiceSession time-budgeted recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    MockWebSocket.instances = [];
    MockWebSocket.mode = "open";
    MockPeerConnection.instances = [];
    MockPeerConnection.nextOptions = {};
    openedControlChannels.length = 0;
  });

  it("an 8 s transport outage restores the session without a new session", async () => {
    vi.useFakeTimers();
    const { session, statuses, errors } = await connectReady();

    setIce(MockPeerConnection.instances[0]!, "disconnected");
    await vi.advanceTimersByTimeAsync(8_000);
    await completeReconnect();

    const states = statuses.flatMap((s) =>
      s.recovery ? [s.recovery.state] : [],
    );
    expect(states).toContain("interrupted");
    const last = session.getConnectionStatus().recovery;
    expect(last?.state).toBe("restored");
    if (last?.state === "restored") {
      expect(last.downtimeMs).toBeGreaterThanOrEqual(8_000);
      expect(last.downtimeMs).toBeLessThan(8_200);
      expect(last.message).toBe("Reconnected.");
    }
    expect(errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED")).toBe(
      false,
    );
    expect(session.getConnectionStatus().ready).toBe(true);
    // Same session credentials: the reconnect socket uses the same URL.
    expect(MockWebSocket.instances.at(-1)!.url).toBe(
      MockWebSocket.instances[0]!.url,
    );
  });

  it("recovery starts within 3 s of ICE failure", async () => {
    vi.useFakeTimers();
    await connectReady();
    const before = MockWebSocket.instances.length;
    MockPeerConnection.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(MockWebSocket.instances.length).toBeGreaterThan(before);
  });

  it("a 4 s ICE disconnect recovers without a rejoin", async () => {
    vi.useFakeTimers();
    const { session, statuses } = await connectReady();
    const wsBefore = MockWebSocket.instances.length;
    const pcBefore = MockPeerConnection.instances.length;
    const pc = MockPeerConnection.instances[0]!;
    setIce(pc, "disconnected");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(statuses.some((s) => s.recovery?.state === "interrupted")).toBe(
      true,
    );
    setIce(pc, "connected");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(MockWebSocket.instances.length).toBe(wsBefore);
    expect(MockPeerConnection.instances.length).toBe(pcBefore);
    const recovery = session.getConnectionStatus().recovery;
    expect(recovery?.state).toBe("restored");
    if (recovery?.state === "restored") {
      expect(recovery.via).toBe("ice-restart");
      expect(recovery.downtimeMs).toBeGreaterThanOrEqual(4_000);
    }
  });

  it("disconnected for 5 s starts a same-session reconnect without a relay step", async () => {
    vi.useFakeTimers();
    const onIceRecovery = vi.fn();
    const { debugLines } = await connectReady({ onIceRecovery });
    const before = MockWebSocket.instances.length;
    setIce(MockPeerConnection.instances[0]!, "disconnected");
    await vi.advanceTimersByTimeAsync(4_900);
    expect(MockWebSocket.instances.length).toBe(before);
    // 5 s wait, then the 1 s delay before reconnect attempt 1.
    await vi.advanceTimersByTimeAsync(1_300);
    expect(MockWebSocket.instances.length).toBeGreaterThan(before);
    expect(onIceRecovery).not.toHaveBeenCalled();
    expect(debugLines.some((l) => l.includes("ice_recovery_relay"))).toBe(
      false,
    );
    expect(debugLines.some((l) => l.includes("reconnect"))).toBe(true);
  });

  it("failed starts the rejoin immediately", async () => {
    vi.useFakeTimers();
    await connectReady();
    const before = MockWebSocket.instances.length;
    const pc = MockPeerConnection.instances[0]!;
    setIce(pc, "disconnected");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(MockWebSocket.instances.length).toBe(before);
    pc.fail();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(MockWebSocket.instances.length).toBeGreaterThan(before);
  });

  it("ICE disconnected that heals within 2 s does not start recovery", async () => {
    vi.useFakeTimers();
    await connectReady();
    const before = MockWebSocket.instances.length;
    const pc = MockPeerConnection.instances[0]!;
    setIce(pc, "disconnected");
    await vi.advanceTimersByTimeAsync(1_500);
    setIce(pc, "connected");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(MockWebSocket.instances.length).toBe(before);
  });

  it("recovery completes within 15 s when the network returns at 10 s", async () => {
    vi.useFakeTimers();
    const { session } = await connectReady();
    MockWebSocket.mode = "error";
    MockPeerConnection.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(10_000);
    MockWebSocket.mode = "open";
    await vi.advanceTimersByTimeAsync(2_100);
    await completeReconnect();
    const recovery = session.getConnectionStatus().recovery;
    expect(recovery?.state).toBe("restored");
    if (recovery?.state === "restored") {
      expect(recovery.downtimeMs).toBeLessThan(15_000);
    }
  });

  it("budget ends at 15 s", async () => {
    vi.useFakeTimers();
    const { errors } = await connectReady();
    MockWebSocket.mode = "error";
    MockPeerConnection.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(14_900);
    expect(errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED")).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED")).toBe(
      true,
    );
  });

  /** Start attempt 1, deliver its offer and leave the replacement peer in ICE `checking`. */
  async function startCheckingAttempt(
    extra: Partial<Parameters<typeof connectBrowserVoiceSession>[0]> = {},
  ) {
    const ready = await connectReady(extra);
    MockPeerConnection.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1_100);
    sendOffer(MockWebSocket.instances.at(-1)!);
    await flush();
    const replacement = MockPeerConnection.instances.at(-1)!;
    setIce(replacement, "checking");
    return { ...ready, replacement };
  }

  const exhausted = (errors: SessionErrorEvent[]): boolean =>
    errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED");

  it("an attempt still checking when its settle timer fires gets extended and can connect", async () => {
    vi.useFakeTimers();
    const { session, replacement, debugLines } = await startCheckingAttempt();
    const wsCount = MockWebSocket.instances.length;
    // Attempt 1 settle timer fires ~6 s after it joined (t ~ 7.1 s).
    await vi.advanceTimersByTimeAsync(6_500);
    expect(
      debugLines.some((l) => l.includes("still connecting — extending settle")),
    ).toBe(true);
    expect(MockWebSocket.instances.length).toBe(wsCount);
    await vi.advanceTimersByTimeAsync(1_000);
    openDataChannels(replacement);
    await flush();
    expect(session.getConnectionStatus().recovery?.state).toBe("restored");
    expect(MockWebSocket.instances.length).toBe(wsCount);
  });

  it("an attempt in flight at budget end gets the grace and restores", async () => {
    vi.useFakeTimers();
    const { session, replacement, errors } = await startCheckingAttempt({
      reconnectBudgetMs: 5_000,
    });
    // startCheckingAttempt leaves the clock at ~1.1 s; the 5 s budget ends at 5 s.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(exhausted(errors)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(exhausted(errors)).toBe(false);
    openDataChannels(replacement);
    await flush();
    expect(session.getConnectionStatus().recovery?.state).toBe("restored");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exhausted(errors)).toBe(false);
  });

  it("no new attempt starts during the grace", async () => {
    vi.useFakeTimers();
    const { errors } = await startCheckingAttempt({ reconnectBudgetMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_000);
    const wsCount = MockWebSocket.instances.length;
    const pcCount = MockPeerConnection.instances.length;
    // Covers the attempt 1 settle timer (t ~ 7.1 s) firing inside the grace.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(exhausted(errors)).toBe(false);
    expect(MockWebSocket.instances.length).toBe(wsCount);
    expect(MockPeerConnection.instances.length).toBe(pcCount);
  });

  it("grace ends without connect -> WEBRTC_RECONNECT_EXHAUSTED", async () => {
    vi.useFakeTimers();
    const { session, errors } = await startCheckingAttempt({
      reconnectBudgetMs: 5_000,
    });
    // Grace runs from the 5 s budget end to 9 s.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(exhausted(errors)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(exhausted(errors)).toBe(true);
    expect(session.getConnectionStatus().recovery).toMatchObject({
      state: "lost",
      reason: "WEBRTC_RECONNECT_EXHAUSTED",
    });
  });

  const ICE_FAILED_LINE = "session/reconnect_attempt_ice_failed";

  it("an attempt whose candidate pairs all failed starts the next attempt without waiting for settle", async () => {
    vi.useFakeTimers();
    const { session, replacement, errors, debugLines } =
      await startCheckingAttempt();
    const wsCount = MockWebSocket.instances.length;
    replacement.pairStates = ["failed", "failed", "failed"];
    await vi.advanceTimersByTimeAsync(2_100);
    const line = debugLines.find((l) => l.includes(ICE_FAILED_LINE));
    expect(line).toBeDefined();
    expect(line).toContain("pairs=3");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(MockWebSocket.instances.length).toBeGreaterThan(wsCount);
    await completeReconnect();
    expect(session.getConnectionStatus().recovery?.state).toBe("restored");
    expect(exhausted(errors)).toBe(false);
  });

  it("one probe with all pairs failed does not abandon the attempt", async () => {
    vi.useFakeTimers();
    const { replacement, debugLines } = await startCheckingAttempt();
    const wsCount = MockWebSocket.instances.length;
    replacement.pairStates = ["failed", "failed"];
    await vi.advanceTimersByTimeAsync(1_050);
    replacement.pairStates = ["failed", "in-progress"];
    await vi.advanceTimersByTimeAsync(3_000);
    expect(debugLines.some((l) => l.includes(ICE_FAILED_LINE))).toBe(false);
    expect(MockWebSocket.instances.length).toBe(wsCount);
  });

  it("pairs still in progress keep the attempt until settle", async () => {
    vi.useFakeTimers();
    const { replacement, debugLines } = await startCheckingAttempt();
    const wsCount = MockWebSocket.instances.length;
    replacement.pairStates = ["in-progress", "waiting"];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(debugLines.some((l) => l.includes(ICE_FAILED_LINE))).toBe(false);
    expect(MockWebSocket.instances.length).toBe(wsCount);
  });

  it("a dead attempt during the grace ends recovery at once", async () => {
    vi.useFakeTimers();
    const { replacement, errors } = await startCheckingAttempt({
      reconnectBudgetMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const wsCount = MockWebSocket.instances.length;
    replacement.pairStates = ["failed", "failed"];
    await vi.advanceTimersByTimeAsync(2_100);
    expect(exhausted(errors)).toBe(true);
    expect(MockWebSocket.instances.length).toBe(wsCount);
  });

  it("a dead attempt at budget end: ice_failed is logged and recovery ends by the grace end", async () => {
    vi.useFakeTimers();
    const { replacement, errors, debugLines } = await startCheckingAttempt({
      reconnectBudgetMs: 5_000,
    });
    replacement.pairStates = ["failed", "failed"];
    await vi.advanceTimersByTimeAsync(2_100);
    expect(debugLines.some((l) => l.includes(ICE_FAILED_LINE))).toBe(true);
    // Attempt 2 is in its 2 s backoff when the 5 s budget ends, so the stale
    // peer connection still counts as in flight and the grace (5 s to 9 s) runs.
    expect(exhausted(errors)).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(exhausted(errors)).toBe(true);
  });

  it("server window 30000 extends the budget to 30 s", async () => {
    vi.useFakeTimers();
    const { errors, debugLines } = await connectReady();
    openedControlChannels[0]!.onmessage?.({
      data: JSON.stringify({
        type: "session_reconnect_token",
        token: "vtrec_x",
        reconnectWindowMs: 30_000,
      }),
    });
    expect(debugLines).toContain(
      "session/reconnect_budget reconnect budget 30000ms (from server)",
    );
    MockWebSocket.mode = "error";
    MockPeerConnection.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED")).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(1_200);
    expect(errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED")).toBe(
      true,
    );
  });

  it("explicit reconnectBudgetMs wins over the server window", async () => {
    vi.useFakeTimers();
    const { errors } = await connectReady({ reconnectBudgetMs: 10_000 });
    openedControlChannels[0]!.onmessage?.({
      data: JSON.stringify({
        type: "session_reconnect_token",
        token: "vtrec_x",
        reconnectWindowMs: 30_000,
      }),
    });
    MockWebSocket.mode = "error";
    MockPeerConnection.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(10_200);
    expect(errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED")).toBe(
      true,
    );
  });

  it("invalid or missing reconnectWindowMs keeps 15 s", async () => {
    vi.useFakeTimers();
    const { errors } = await connectReady();
    for (const reconnectWindowMs of [undefined, "30000", 1_000, 500_000, NaN]) {
      openedControlChannels[0]!.onmessage?.({
        data: JSON.stringify({
          type: "session_reconnect_token",
          token: "vtrec_x",
          reconnectWindowMs,
        }),
      });
    }
    MockWebSocket.mode = "error";
    MockPeerConnection.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(14_900);
    expect(errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED")).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED")).toBe(
      true,
    );
  });

  it("gives up after the 15 s budget with WEBRTC_RECONNECT_EXHAUSTED and a lost status", async () => {
    vi.useFakeTimers();
    const { session, errors } = await connectReady();
    MockWebSocket.mode = "error";
    MockPeerConnection.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED")).toBe(
      false,
    );
    expect(MockWebSocket.instances.length).toBeGreaterThan(4);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED")).toBe(
      true,
    );
    const recovery = session.getConnectionStatus().recovery;
    expect(recovery).toMatchObject({
      state: "lost",
      reason: "WEBRTC_RECONNECT_EXHAUSTED",
      message:
        "The connection could not be restored. Please start a new conversation.",
    });
    const wsCount = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(MockWebSocket.instances.length).toBe(wsCount);
  });

  it("ws failure log line contains code, reason, httpStatus and attempt", async () => {
    vi.useFakeTimers();
    const { debugLines } = await connectReady({
      credentials: { ...credentials, signaling_url: "ws://h/ws?token=secret" },
    });
    MockWebSocket.mode = "error";
    MockPeerConnection.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1_000);
    const line = debugLines.find((l) => l.includes("signaling ws failed"));
    expect(line).toBeDefined();
    expect(line).toMatch(/attempt=\d+/);
    expect(line).toMatch(/elapsed=\d+/);
    expect(line).toContain("phase=connect");
    expect(line).toContain("code=1006");
    expect(line).toMatch(/reason=/);
    expect(line).toContain("httpStatus=n/a");
    expect(line).toContain("wasClean=false");
    expect(line).not.toContain("secret");
  });

  it("disconnect sends client_hangup on the control channel before closing", async () => {
    const { session } = await connectReady();
    const control = openedControlChannels[0]!;
    session.disconnect();
    expect(control.sent).toEqual([
      JSON.stringify({ type: CLIENT_HANGUP_MESSAGE_TYPE }),
    ]);
    expect(CLIENT_HANGUP_MESSAGE_TYPE).toBe("client_hangup");
  });

  it("disconnectAsync sends client_hangup once", async () => {
    const { session } = await connectReady();
    const control = openedControlChannels[0]!;
    await session.disconnectAsync();
    expect(control.sent).toEqual([
      JSON.stringify({ type: CLIENT_HANGUP_MESSAGE_TYPE }),
    ]);
  });

  it("reconnect does not send client_hangup", async () => {
    vi.useFakeTimers();
    const { session } = await connectReady();
    const control = openedControlChannels[0]!;
    // Unintentional loss, automatic recovery, then a manual reconnect.
    MockPeerConnection.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1_000);
    await completeReconnect();
    await session.reconnect();
    await flush();
    expect(control.sent).toEqual([]);
    for (const channel of openedControlChannels) {
      expect(channel.sent).toEqual([]);
    }
  });
});

describe("recovery keeps the old peer connection until it is replaced", () => {
  afterEach(() => {
    vi.useRealTimers();
    MockWebSocket.instances = [];
    MockWebSocket.mode = "open";
    MockPeerConnection.instances = [];
    MockPeerConnection.nextOptions = {};
    openedControlChannels.length = 0;
  });

  it("recovery does not close the old peer connection or its data channels before the replacement join", async () => {
    vi.useFakeTimers();
    await connectReady();
    const oldPc = MockPeerConnection.instances[0]!;
    const oldControl = openedControlChannels[0]!;
    const pcClose = vi.spyOn(oldPc, "close");
    const dcClose = vi.spyOn(oldControl, "close");
    const wsBefore = MockWebSocket.instances.length;

    setIce(oldPc, "disconnected");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(MockWebSocket.instances.length).toBeGreaterThan(wsBefore);

    // Replacement offer arrives and a new PC exists, but it is not connected yet.
    sendOffer(MockWebSocket.instances.at(-1)!);
    await flush();
    expect(MockPeerConnection.instances.length).toBe(2);
    expect(pcClose).not.toHaveBeenCalled();
    expect(dcClose).not.toHaveBeenCalled();
    expect(oldControl.sent).toEqual([]);
  });

  it("a second recovery in the same session keeps the current connection until the replacement join", async () => {
    vi.useFakeTimers();
    await connectReady();
    const firstPc = MockPeerConnection.instances[0]!;
    setIce(firstPc, "disconnected");
    await vi.advanceTimersByTimeAsync(9_000);
    await completeReconnect();
    expect(MockPeerConnection.instances.length).toBe(2);

    const currentPc = MockPeerConnection.instances[1]!;
    const currentControl = openedControlChannels[1]!;
    const pcClose = vi.spyOn(currentPc, "close");
    const dcClose = vi.spyOn(currentControl, "close");
    const wsBefore = MockWebSocket.instances.length;

    setIce(currentPc, "disconnected");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(MockWebSocket.instances.length).toBeGreaterThan(wsBefore);
    expect(pcClose).not.toHaveBeenCalled();
    expect(dcClose).not.toHaveBeenCalled();

    // Fresh server offer for the re-joined peer: the current PC must still stay open.
    sendOffer(MockWebSocket.instances.at(-1)!);
    await flush();
    expect(MockPeerConnection.instances.length).toBe(3);
    expect(pcClose).not.toHaveBeenCalled();
    expect(dcClose).not.toHaveBeenCalled();
    expect(currentControl.sent).toEqual([]);

    openDataChannels(MockPeerConnection.instances[2]!);
    await flush();
    expect(pcClose).toHaveBeenCalledTimes(1);
  });

  it("a second recovery after a slow first reconnect keeps the current connection", async () => {
    vi.useFakeTimers();
    await connectReady();
    setIce(MockPeerConnection.instances[0]!, "disconnected");
    await vi.advanceTimersByTimeAsync(9_000);
    // First reconnect: the replacement offer arrives, ICE connects late.
    sendOffer(MockWebSocket.instances.at(-1)!);
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);
    await completeReconnect();
    const currentPc = MockPeerConnection.instances.at(-1)!;
    const currentControl = openedControlChannels.at(-1)!;
    const countBefore = MockPeerConnection.instances.length;
    const pcClose = vi.spyOn(currentPc, "close");
    const dcClose = vi.spyOn(currentControl, "close");
    const wsBefore = MockWebSocket.instances.length;

    setIce(currentPc, "disconnected");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(MockWebSocket.instances.length).toBeGreaterThan(wsBefore);
    expect(pcClose).not.toHaveBeenCalled();
    expect(dcClose).not.toHaveBeenCalled();

    sendOffer(MockWebSocket.instances.at(-1)!);
    await flush();
    expect(MockPeerConnection.instances.length).toBe(countBefore + 1);
    expect(pcClose).not.toHaveBeenCalled();
    expect(dcClose).not.toHaveBeenCalled();
  });

  it("third consecutive recovery also keeps the current connection until replaced", async () => {
    vi.useFakeTimers();
    await connectReady();
    for (let round = 0; round < 2; round += 1) {
      setIce(MockPeerConnection.instances.at(-1)!, "disconnected");
      await vi.advanceTimersByTimeAsync(9_000);
      await completeReconnect();
    }
    expect(MockPeerConnection.instances.length).toBe(3);

    const currentPc = MockPeerConnection.instances[2]!;
    const currentControl = openedControlChannels[2]!;
    const pcClose = vi.spyOn(currentPc, "close");
    const dcClose = vi.spyOn(currentControl, "close");

    setIce(currentPc, "disconnected");
    await vi.advanceTimersByTimeAsync(9_000);
    sendOffer(MockWebSocket.instances.at(-1)!);
    await flush();
    expect(MockPeerConnection.instances.length).toBe(4);
    expect(pcClose).not.toHaveBeenCalled();
    expect(dcClose).not.toHaveBeenCalled();

    openDataChannels(MockPeerConnection.instances[3]!);
    await flush();
    expect(pcClose).toHaveBeenCalledTimes(1);
  });

  it("the old peer connection is closed after the replacement connects", async () => {
    vi.useFakeTimers();
    await connectReady();
    const oldPc = MockPeerConnection.instances[0]!;
    const pcClose = vi.spyOn(oldPc, "close");

    setIce(oldPc, "disconnected");
    await vi.advanceTimersByTimeAsync(9_000);
    await completeReconnect();

    expect(MockPeerConnection.instances.length).toBe(2);
    expect(pcClose).toHaveBeenCalledTimes(1);
    expect(openedControlChannels[0]!.sent).toEqual([]);
  });

  it("the old peer connection is closed when recovery gives up", async () => {
    vi.useFakeTimers();
    const { errors } = await connectReady();
    const oldPc = MockPeerConnection.instances[0]!;
    const pcClose = vi.spyOn(oldPc, "close");
    MockWebSocket.mode = "error";

    oldPc.fail();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pcClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16_000);

    expect(errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED")).toBe(
      true,
    );
    expect(pcClose).toHaveBeenCalledTimes(1);
  });
});

describe("reconnect token rejected by the gateway (Node ws)", () => {
  it("a 401 on the reconnect token ends immediately with SESSION_ENDED_DURING_RECONNECT", async () => {
    let upgrades = 0;
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    const serverSockets: import("ws").WebSocket[] = [];
    server.on("upgrade", (request, socket, head) => {
      upgrades += 1;
      if (upgrades > 1) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        serverSockets.push(ws);
        wss.emit("connection", ws, request);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;

    const errors: SessionErrorEvent[] = [];
    const debugLines: string[] = [];
    try {
      const session = await connectBrowserVoiceSession({
        credentials: {
          ...credentials,
          signaling_url: `ws://127.0.0.1:${port}/ws`,
        },
        requestMic: false,
        readiness: "data",
        runtime: {
          WebSocket:
            NodeWebSocketAdapter as unknown as WebRtcRuntime["WebSocket"],
          RTCPeerConnection:
            MockPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
        },
        onSessionError: (event) => errors.push(event),
        onDebugEvent: {
          info: () => undefined,
          warn: (s: string, n: string, d?: string) =>
            debugLines.push(`${s}/${n} ${d ?? ""}`),
          error: (s: string, n: string, d?: string) =>
            debugLines.push(`${s}/${n} ${d ?? ""}`),
          debug: () => undefined,
        } as never,
      });
      serverSockets[0]!.send(
        JSON.stringify({
          type: "offer",
          peerId: VOICE_AGENT_SERVER_PEER_ID,
          sdp: {
            type: "offer",
            sdp: "v=0\r\na=ice-ufrag:server\r\na=ice-pwd:secret\r\n",
          },
        }),
      );
      await vi.waitFor(() =>
        expect(MockPeerConnection.instances).toHaveLength(1),
      );
      await flush();
      openDataChannels(MockPeerConnection.instances[0]!);
      await session.waitForConnected(1_000);

      const startedAt = Date.now();
      serverSockets[0]!.terminate();
      await vi.waitFor(
        () =>
          expect(
            errors.some((e) => e.code === "SESSION_ENDED_DURING_RECONNECT"),
          ).toBe(true),
        { timeout: 2_000 },
      );
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(errors.some((e) => e.code === "WEBRTC_RECONNECT_EXHAUSTED")).toBe(
        false,
      );
      expect(session.getConnectionStatus().recovery).toMatchObject({
        state: "lost",
        reason: "SESSION_ENDED_DURING_RECONNECT",
        message:
          "The conversation ended while the connection was down. Please start a new one.",
      });
      expect(debugLines.some((l) => l.includes("httpStatus=401"))).toBe(true);
      session.disconnect();
    } finally {
      for (const ws of serverSockets) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
