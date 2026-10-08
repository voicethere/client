import {
  createConnectionError,
  dispatchConnectionError,
} from "../connection-errors.js";

import { appendJoinToken } from "../resolve-connection.js";
import {
  createLocalSessionError,
  emitSessionError,
  isSessionErrorEvent,
  parseLegacyAgentError,
  type SessionErrorEvent,
  type SessionErrorHandler,
} from "../session-errors.js";
import type { SessionCredentials } from "./session-provision.js";
import type { DebugConsole } from "./debug-console.js";
import {
  buildWebRtcConnectionStatus,
  CONNECTION_INTERRUPTED_MESSAGE,
  CONNECTION_LOST_MESSAGE,
  CONNECTION_RESTORED_MESSAGE,
  CONNECTION_SESSION_ENDED_MESSAGE,
  isHalfOpenConnection,
  formatWebRtcConnectTimeoutMessage,
  isWebRtcConnectionReady,
  resolveHalfOpenFailFastMs,
  resolveReadinessProfile,
  type WebRtcConnectionSnapshot,
  type WebRtcConnectionStatus,
  type WebRtcReadinessProfile,
} from "./webrtc-connection-status.js";
import {
  collectWebRtcDiagnostics,
  type WebRtcDiagnostics,
} from "./webrtc-diagnostics.js";
import {
  getDefaultBrowserRuntime,
  type WebRtcRuntime,
} from "./webrtc-runtime.js";
import {
  closePeerConnectionAwaitable,
  type PeerCloseResult,
} from "./peer-connection-close.js";
import {
  emitDiagnosticSafely,
  redactDiagnosticDetail,
  type VoiceSessionDiagnosticHandler,
} from "./voice-session-diagnostics.js";
import { waitForIceGatheringComplete } from "./wait-for-ice-gathering.js";
import {
  isWebRtcConnectRetryError,
  WebRtcConnectRetryError,
} from "./webrtc-connect-retry.js";
import {
  acquireAudioInput,
  listAudioInputDevices as listBrowserAudioInputDevices,
  type AudioInputState,
} from "./microphone.js";
import {
  createHiddenAudioElement,
  unlockAudioPlayback as unlockAudioPlaybackElement,
  type AudioPlaybackState,
} from "./audio-playback.js";

export type { AudioPlaybackState } from "./audio-playback.js";

/** High-rate DC traffic logged at debug level — E2E stderr needs `LOAD_TEST_CLIENT_DEBUG=1`. */
const HIGH_FREQUENCY_DC_TYPES = new Set([
  "keepalive",
  "state",
  "tick",
  "position",
]);

/**
 * Native RTCPeerConnection rejects offers without `a=ice-ufrag` (empty or truncated SDP).
 * Detect before setRemoteDescription so we can same-session reconnect instead of hanging.
 */
export function remoteOfferHasIceUfrag(
  sdp: RTCSessionDescriptionInit | null | undefined,
): boolean {
  const body = typeof sdp?.sdp === "string" ? sdp.sdp : "";
  return /a=ice-ufrag\s*:/i.test(body);
}

/** Plain JSON session description for signaling (string `sdp`, not a live PC object). */
export function toSessionDescriptionInit(
  desc: RTCSessionDescription | RTCSessionDescriptionInit | null,
): RTCSessionDescriptionInit | null {
  if (!desc) return null;
  if (typeof (desc as RTCSessionDescription).toJSON === "function") {
    return (desc as RTCSessionDescription).toJSON();
  }
  return {
    type: desc.type,
    sdp: typeof desc.sdp === "string" ? desc.sdp : "",
  };
}

function logDcMessage(
  debug: DebugConsole | undefined,
  name: string,
  detail?: string,
): void {
  if (!debug) return;
  if (HIGH_FREQUENCY_DC_TYPES.has(name)) {
    debug.debug("dc", name, detail);
    return;
  }
  debug.info("dc", name, detail);
}

function redactSignalingUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("token")) {
      parsed.searchParams.set("token", "…");
    }
    return parsed.toString();
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/**
 * Default total time from the first transport loss during which the client keeps trying.
 * The platform keeps a dropped session for about 15 s, so retrying longer than 15 s
 * only ends in a 401 and `SESSION_ENDED_DURING_RECONNECT`.
 */
export const DEFAULT_RECONNECT_BUDGET_MS = 15_000;
/** ICE `disconnected` must last this long before the user sees "interrupted". */
const ICE_DISCONNECTED_GRACE_MS = 2_000;
/**
 * Default time an ICE `disconnected` connection gets to come back on its own before
 * the client rejoins. The whole recovery (wait, rejoin, ready) has to fit in the
 * platform's 15 s window, and a rejoin replaces (destroys) the old peer on the
 * server, so rejoining early can turn a recoverable blip into a lost session.
 */
export const DEFAULT_REJOIN_AFTER_DISCONNECTED_MS = 5_000;
/** Time the relay ICE recovery rejoin gets to reach readiness before escalating. */
const ICE_RECOVERY_SETTLE_MS = 5_000;
/** Time a same-session reconnect gets to reach readiness before the next attempt. */
const RECONNECT_SETTLE_MS = 6_000;
/** One-time extra settle time for an attempt whose replacement peer is still connecting. */
const RECONNECT_SETTLE_EXTEND_MS = 3_000;
/** How often a reconnect attempt's candidate pairs are checked while it settles. */
const RECONNECT_DEAD_PAIRS_PROBE_MS = 1_000;
/** Consecutive probes with every candidate pair failed before the attempt counts as dead. */
const RECONNECT_DEAD_PAIRS_CONFIRM = 2;
/**
 * Extra time an attempt that is in flight when the budget ends gets to connect.
 * No new attempt starts during it.
 */
export const RECONNECT_INFLIGHT_GRACE_MS = 4_000;
/** Reconnect signaling WebSocket must open within this time. */
const SIGNALING_CONNECT_TIMEOUT_MS = 4_000;
/** Delay before same-session reconnect attempt 1, 2, 3, then every later attempt. */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 2_000, 2_000] as const;

/** The gateway rejected the reconnect token (HTTP 401): the session no longer exists. */
class SessionEndedDuringReconnectError extends Error {
  constructor() {
    super("signaling rejected the reconnect token (HTTP 401)");
    this.name = "SessionEndedDuringReconnectError";
  }
}

/**
 * Sent on the control channel when the integrator ends the session, so the runner
 * closes immediately instead of holding a dropped peer through its network-drop grace.
 */
export const CLIENT_HANGUP_MESSAGE_TYPE = "client_hangup";
/** Max wait for the hangup message to leave the send buffer during `disconnectAsync`. */
const CLIENT_HANGUP_DRAIN_MS = 200;

export const VOICE_AGENT_SERVER_PEER_ID = "voice-agent-server";
export const VOICE_CONTROL_CHANNEL_LABEL = "voice-control";
/** High-frequency binary sync channel (matches `@node-webrtc-rust/sdk/voice`). */
export const VOICE_SYNC_CHANNEL_LABEL = "voicethere-sync";

export type DataChannelKind = "control" | "sync";

/** Fired for binary frames on voice-control data channel. */
export type BinaryMessageHandler = (data: ArrayBuffer) => void;
/** Fired for binary frames on voicethere-sync data channel. */
export type SyncBinaryMessageHandler = (data: ArrayBuffer) => void;

export type ReconnectPolicy = "same-session" | "new-session";

/** Passed as optional 2nd arg to same-session reconnect / ICE recovery callbacks. */
export type VoiceSessionReconnectInfo = {
  reason: string;
  /** Effective RTCConfiguration.iceTransportPolicy for the next/current PC. */
  iceTransportPolicy?: "all" | "relay";
};

export type BrowserVoiceSessionOptions = {
  credentials: SessionCredentials;
  /**
   * Signaling peer id for this browser tab. Default: `client-<random>`.
   *
   * **VoiceThere runners** (`VoiceAgentSessionHost` / `SessionPod`) only negotiate
   * WebRTC with peers whose id starts with `client-` unless the server sets a
   * custom `clientPeerIdPrefix`. Other ids join signaling but never get an SDP offer.
   *
   * @see https://github.com/akirilyuk/node-webrtc-rust/blob/main/docs/signaling-peer-ids.md
   */
  peerId?: string;
  requestMic?: boolean;
  /** Preferred audio input device id (`deviceId: { ideal }` for getUserMedia). */
  audioInputDeviceId?: string;
  /**
   * `silent` (default) — SDK pumps silent 20 ms frames on the mic track after connect.
   * `external` — caller owns `writeSample` on the mic track (load tests, scripted PCM).
   */
  micPump?: "silent" | "external";
  audioElement?: HTMLAudioElement;
  onDebugEvent?: DebugConsole;
  /** Injectable WebRTC runtime (default: browser globals). */
  runtime?: WebRtcRuntime;
  /**
   * ICE transport policy for the peer connection (`all` | `relay`).
   * Passed through to `RTCConfiguration.iceTransportPolicy`.
   */
  iceTransportPolicy?: "all" | "relay";
  /** Structured diagnostics (peer close) — redacted; exceptions never affect lifecycle. */
  onDiagnosticEvent?: VoiceSessionDiagnosticHandler;
  /** Opaque context forwarded to runner/agent on session start. */
  customerContext?: Record<string, unknown>;
  /** Unified handler for session_error DC events and local WebRTC failures. */
  onSessionError?: SessionErrorHandler;
  /** Fired for JSON messages on voice-control (e.g. speech_event). */
  onControlMessage?: (payload: Record<string, unknown>) => void;
  /** Fired for binary frames on voice-control. */
  onBinaryMessage?: BinaryMessageHandler;
  /** Fired for binary frames on voicethere-sync. */
  onSyncBinaryMessage?: SyncBinaryMessageHandler;
  /**
   * Fired when the agent's remote audio track arrives (Node: {@link @node-webrtc-rust/sdk} RemoteAudioTrack).
   * Use for client-side STT on agent TTS playback (e2e voice-smoke, load tests).
   */
  onAgentAudioTrack?: (track: MediaStreamTrack) => void;
  /**
   * `same-session` (default) retries signaling/WebRTC with the same credentials on
   * unintentional disconnect. `new-session` disables auto-retry — call `startSession()`
   * again for a fresh orchestrator session id.
   */
  reconnectPolicy?: ReconnectPolicy;
  /**
   * Total time (default 20000 ms; the platform keeps a dropped session for about 15 s) from the first transport loss after the session
   * was ready during which the client keeps trying to restore it. Recovery starts
   * within 3 s of the loss; when the budget is spent the session fails with
   * `WEBRTC_RECONNECT_EXHAUSTED` and a `lost` {@link WebRtcConnectionStatus.recovery}.
   */
  reconnectBudgetMs?: number;
  /**
   * How long (default 8000 ms) a connection may stay ICE `disconnected` before the
   * client rejoins the session. The "interrupted" status is published after 2 s; if the
   * connection returns within this window it is restored without a rejoin. A `failed`
   * connection or a signaling close while the transport is down rejoins immediately.
   */
  rejoinAfterDisconnectedMs?: number;
  /**
   * Overrides the default human messages carried on
   * {@link WebRtcConnectionStatus.recovery}.
   */
  connectionStatusMessages?: Partial<{
    interrupted: string;
    restored: string;
    lost: string;
    sessionEnded: string;
  }>;
  /**
   * Optional cap on same-session reconnect attempts (kept for compatibility).
   * When omitted, a session that was ready retries until {@link reconnectBudgetMs}
   * is spent; before the first ready state the cap is 4. `waitForConnected()` keeps
   * waiting through these attempts until `timeoutMs` elapses. Set `0` to fail on the
   * first transport error.
   */
  maxAutoReconnectAttempts?: number;
  /**
   * Relay-leaning ICE recovery attempts before counting toward
   * {@link maxAutoReconnectAttempts} / {@link onReconnecting} (default 1).
   * Set `0` to skip ICE recovery and use legacy auto-reconnect only.
   */
  maxIceRecoveryAttempts?: number;
  /**
   * When ICE stays in `checking` (or PC `connecting`) with `nominated=0` for at
   * least this many ms, trigger {@link maxIceRecoveryAttempts} recovery early.
   * Default 12000; set `0` to disable proactive stuck-checking recovery.
   */
  iceRecoveryStuckCheckingMs?: number;
  /** Fired when starting an ICE recovery attempt (not {@link onReconnecting}). */
  onIceRecovery?: (attempt: number, info?: VoiceSessionReconnectInfo) => void;
  onReconnecting?: (attempt: number, info?: VoiceSessionReconnectInfo) => void;
  /**
   * Fired when same-session reconnect (auto or manual) reaches readiness again
   * after the initial connect — not on first connect.
   */
  onReconnected?: (attempt: number, info?: VoiceSessionReconnectInfo) => void;
  /**
   * Readiness gate for `waitForConnected()` / `getConnectionStatus().ready`.
   * Defaults from `requestMic`: voice sessions wait for inbound+outbound audio tracks;
   * data sessions wait for voice-control and voicethere-sync channels to open.
   */
  readiness?: WebRtcReadinessProfile;
  /** Fired whenever WebRTC connection readiness changes (signaling through media/DCs). */
  onConnectionStatus?: (status: WebRtcConnectionStatus) => void;
  /** Fired when inbound agent audio playback starts or is blocked by the browser. */
  onAudioPlayback?: (state: AudioPlaybackState) => void;
};

export type BrowserVoiceSession = {
  peerId: string;
  /**
   * Synchronous terminal invalidation (reconnect-friendly; uses sync `pc.close()`).
   * Does not await native close — prefer {@link disconnectAsync} for soak/capacity.
   * Safe if async close is in flight: does not call a second close or mask failure.
   */
  disconnect: () => void;
  /**
   * Awaitable terminal cleanup barrier (Node `closeAsync` when present).
   * Returns strict {@link PeerCloseResult} so callers can observe closed/timed_out/failed.
   */
  disconnectAsync: () => Promise<PeerCloseResult>;
  /** Ask the server to close this WebRTC leg (graceful close signal on voice-control). */
  sendCloseSignal: (reason?: string) => void;
  sendSpeak: (text: string) => void;
  sendChat: (text: string) => void;
  /** JSON on voice-control (same as sendChat for `{ type: 'chat' }`). */
  sendToAgent: (payload: Record<string, unknown>) => void;
  /** Binary on voice-control data channel. */
  sendBinary: (data: ArrayBuffer | Uint8Array) => void;
  /** Binary on voicethere-sync data channel (throws if channel not open). */
  sendSyncBinary: (data: ArrayBuffer | Uint8Array) => void;
  getMicStream: () => MediaStream | null;
  /** Enumerate `audioinput` devices (labels empty until mic permission granted). */
  listAudioInputDevices: () => Promise<{ deviceId: string; label: string }[]>;
  /** Active input device id from the live track settings, or null when synthetic. */
  getAudioInputDeviceId: () => string | null;
  getAudioInputState: () => AudioInputState;
  /**
   * Switch microphone mid-session via `RTCRtpSender.replaceTrack`.
   * `null` selects the default device. Falls back to synthetic on GUM failure.
   */
  setAudioInputDevice: (deviceId: string | null) => Promise<void>;
  /**
   * Re-prompt for microphone access. Returns true and replaces the outbound track on
   * success; false keeps the current (possibly synthetic) stream.
   */
  requestAudioInputAccess: () => Promise<boolean>;
  /** Inbound agent audio playback state (`idle` until first ontrack play attempt). */
  getAudioPlaybackState: () => AudioPlaybackState;
  /**
   * Retry playback on the attached audio element (call from a user gesture when
   * {@link getAudioPlaybackState} is `blocked`).
   */
  unlockAudioPlayback: () => Promise<boolean>;
  /**
   * Resolves when the session meets the readiness profile (voice: PC + inbound/outbound
   * audio tracks; data: PC + both data channels open) or rejects on timeout/failure.
   * With the default `reconnectPolicy: "same-session"`, transient ICE/WebRTC failures
   * trigger an automatic same-session reconnect and this call keeps waiting until
   * `timeoutMs` (across retries) unless `maxAutoReconnectAttempts` is exhausted.
   */
  waitForConnected: (timeoutMs?: number) => Promise<void>;
  getConnectionState: () => RTCPeerConnectionState | "new";
  getConnectionStatus: () => WebRtcConnectionStatus;
  /** ICE / candidate-pair snapshot for connect failure triage. */
  getWebRtcDiagnostics: () => Promise<WebRtcDiagnostics | null>;
  /** Re-open signaling with the same credentials and peer id (same orchestrator session). */
  reconnect: () => Promise<void>;
  /**
   * Test/E2E hook — force-close the signaling WebSocket so `signaling_closed`
   * auto-reconnect runs (e.g. after `session_reconnect_token` updates join credentials).
   */
  forceCloseSignalingForTests: () => void;
};

function defaultPeerId(): string {
  return `client-${Math.random().toString(36).slice(2, 10)}`;
}

function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

/** Node {@link @node-webrtc-rust/sdk} LocalAudioTrack — remote ontrack needs RTP via writeSample. */
type WriteSampleTrack = {
  writeSample: (data: Uint8Array, durationMs: number) => Promise<void>;
};

function isWriteSampleTrack(track: unknown): track is WriteSampleTrack {
  return (
    typeof track === "object" &&
    track !== null &&
    typeof (track as WriteSampleTrack).writeSample === "function"
  );
}

async function attachMicTracks(
  pc: RTCPeerConnection,
  micStream: MediaStream,
): Promise<RTCRtpSender | null> {
  let micSender: RTCRtpSender | null = null;
  for (const track of micStream.getAudioTracks()) {
    const result = pc.addTrack(track as MediaStreamTrack, micStream) as
      RTCRtpSender | Promise<RTCRtpSender> | void;
    let sender: RTCRtpSender | void = result as RTCRtpSender | void;
    if (
      result &&
      typeof (result as Promise<RTCRtpSender>).then === "function"
    ) {
      sender = await result;
    }
    if (sender && !micSender) {
      micSender = sender;
    }
  }
  return micSender;
}

function createMicPump(
  micStream: MediaStream | null,
  isConnected: () => boolean,
  debug?: DebugConsole,
): () => void {
  let running = true;
  void (async () => {
    if (!micStream) return;
    const silentFrame = new Uint8Array(3840);
    for (const track of micStream.getAudioTracks()) {
      if (!isWriteSampleTrack(track)) continue;
      try {
        await track.writeSample(new Uint8Array(960), 5);
        debug?.info("voice", "mic_kick_sent");
        while (running && isConnected()) {
          await track.writeSample(silentFrame, 20);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        debug?.warn("voice", "mic_pump_failed", message);
      }
    }
  })();
  return () => {
    running = false;
  };
}

export async function connectBrowserVoiceSession(
  options: BrowserVoiceSessionOptions,
): Promise<BrowserVoiceSession> {
  const debug = options.onDebugEvent;
  const runtime = options.runtime ?? getDefaultBrowserRuntime();
  const peerId = options.peerId ?? defaultPeerId();
  const roomId = options.credentials.room_id;
  const orchestratorSessionId = options.credentials.session_id;
  /** Mutable join credentials — updated by inbound `session_reconnect_token`. */
  const joinCredentials: SessionCredentials = { ...options.credentials };
  const rebuildSignalingUrl = (): string =>
    appendJoinToken(joinCredentials.signaling_url, joinCredentials.join_token);
  let signalingUrl = rebuildSignalingUrl();
  const iceServers = options.credentials.ice_servers?.length
    ? options.credentials.ice_servers
    : [{ urls: "stun:stun.l.google.com:19302" }];

  let ws: WebSocket | null = null;
  let pc: RTCPeerConnection | null = null;
  let controlChannel: RTCDataChannel | null = null;
  let syncChannel: RTCDataChannel | null = null;
  let micStream: MediaStream | null = null;
  let micRtpSender: RTCRtpSender | null = null;
  let audioInputState: AudioInputState = "synthetic";
  let audioInputDeviceId: string | null = null;
  let disposeMicHandle: (() => void) | null = null;
  const ownedAudioElement =
    options.requestMic !== false && !options.audioElement
      ? createHiddenAudioElement()
      : null;
  const playbackAudioElement = options.audioElement ?? ownedAudioElement;
  let audioPlaybackState: AudioPlaybackState = "idle";
  const disposeOwnedAudioElement = (): void => {
    if (!ownedAudioElement) return;
    try {
      ownedAudioElement.pause();
      ownedAudioElement.srcObject = null;
      ownedAudioElement.remove();
    } catch {
      /* ignore */
    }
  };
  const setAudioPlaybackState = (state: AudioPlaybackState): void => {
    audioPlaybackState = state;
    options.onAudioPlayback?.(state);
  };
  const attemptInboundAudioPlayback = async (): Promise<void> => {
    if (!playbackAudioElement) return;
    const ok = await unlockAudioPlaybackElement(playbackAudioElement);
    if (ok) {
      setAudioPlaybackState("playing");
    } else {
      debug?.warn("webrtc", "audio_playback_blocked");
      setAudioPlaybackState("blocked");
    }
  };
  /** ICE candidates queued by negotiation generation until that PC is ready. */
  const pendingIceByGeneration = new Map<number, RTCIceCandidateInit[]>();
  let connectionState: RTCPeerConnectionState | "new" = "new";
  let resolveConnected: (() => void) | null = null;
  let rejectConnected: ((error: Error) => void) | null = null;
  let connectedPromise: Promise<void> | null = null;
  let pendingConnectFailure: Error | null = null;
  let stopMicPump: (() => void) | null = null;
  let gracefulDisconnect = false;
  /** Bumped on each offer / disconnect so stale answer/ICE paths cannot resurrect. */
  let negotiationGeneration = 0;
  /** Serializes overlapping createAnswer/setLocalDescription/gather/send paths. */
  let offerChain: Promise<void> = Promise.resolve();
  let disconnectAsyncInFlight: Promise<PeerCloseResult> | null = null;
  /** Cached terminal disconnect outcome — repeats must not invent `closed` for a null pc. */
  let terminalDisconnectResult: PeerCloseResult | null = null;
  /** Generation of the live PC (mirrors offer gen at create); ICE/handlers ignore mismatches. */
  let activePcGeneration = 0;
  /**
   * Signaling/reconnect epoch. Incremented only when starting a reconnect flight
   * or on disconnect (invalidates in-flight WS handlers).
   */
  let signalingEpoch = 0;
  /** True single-flight: concurrent reconnect callers share this promise. */
  let reconnectFlight: Promise<void> | null = null;
  /**
   * After a timed_out/failed replace-close, further PC creation is blocked.
   * The unsafe native PC may still be live — never invent `closed`.
   */
  let replacementBlockedResult: PeerCloseResult | null = null;
  /** Retained reference after failed replace-close (do not retry native close). */
  let quarantinedPc: RTCPeerConnection | null = null;
  /** Per-PC intentional retire tracking (replaces a global ignore boolean). */
  const intentionallyRetiringPcs = new WeakSet<RTCPeerConnection>();
  /**
   * Peer connections retired by recovery but not yet closed. Closing the old PC
   * before the replacement connects can reach the server as a remote close of the
   * control channel, which it reads as a hang-up. They close once the replacement
   * is connected, or when recovery ends.
   */
  const deferredOldPcs: RTCPeerConnection[] = [];
  const closeDeferredOldPeerConnections = (): void => {
    const olds = deferredOldPcs.splice(0, deferredOldPcs.length);
    for (const old of olds) {
      if (old === quarantinedPc) continue;
      intentionallyRetiringPcs.add(old);
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
  };

  const clearPendingIceGenerations = (keepGeneration?: number): void => {
    if (keepGeneration === undefined) {
      pendingIceByGeneration.clear();
      return;
    }
    for (const generation of [...pendingIceByGeneration.keys()]) {
      if (generation !== keepGeneration) {
        pendingIceByGeneration.delete(generation);
      }
    }
  };

  const queuePendingIce = (
    generation: number,
    candidate: RTCIceCandidateInit,
  ): void => {
    const bucket = pendingIceByGeneration.get(generation);
    if (bucket) {
      bucket.push(candidate);
    } else {
      pendingIceByGeneration.set(generation, [candidate]);
    }
  };

  const drainPendingIce = async (
    targetPc: RTCPeerConnection,
    generation: number,
  ): Promise<void> => {
    const bucket = pendingIceByGeneration.get(generation) ?? [];
    pendingIceByGeneration.delete(generation);
    for (const candidate of bucket) {
      await targetPc.addIceCandidate(candidate).catch(() => undefined);
    }
  };

  const assertReplacementAllowed = (): void => {
    if (replacementBlockedResult) {
      throw new Error(
        `peer replacement blocked: previous close ${replacementBlockedResult.status}`,
      );
    }
  };
  const reconnectPolicy = options.reconnectPolicy ?? "same-session";
  /** Explicit `reconnectBudgetMs` wins; otherwise the server's reconnect window may replace the default. */
  let reconnectBudgetMs =
    options.reconnectBudgetMs ?? DEFAULT_RECONNECT_BUDGET_MS;
  const rejoinAfterDisconnectedMs =
    options.rejoinAfterDisconnectedMs ?? DEFAULT_REJOIN_AFTER_DISCONNECTED_MS;
  const statusMessages = {
    interrupted:
      options.connectionStatusMessages?.interrupted ??
      CONNECTION_INTERRUPTED_MESSAGE,
    restored:
      options.connectionStatusMessages?.restored ?? CONNECTION_RESTORED_MESSAGE,
    lost: options.connectionStatusMessages?.lost ?? CONNECTION_LOST_MESSAGE,
    sessionEnded:
      options.connectionStatusMessages?.sessionEnded ??
      CONNECTION_SESSION_ENDED_MESSAGE,
  };
  const maxIceRecoveryAttempts = options.maxIceRecoveryAttempts ?? 1;
  const iceRecoveryStuckCheckingMs =
    options.iceRecoveryStuckCheckingMs ?? 12_000;
  let effectiveIceTransportPolicy = options.iceTransportPolicy;
  let autoReconnectAttempts = 0;
  let iceRecoveryAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let iceStuckWatchTimer: ReturnType<typeof setInterval> | undefined;
  let iceCheckingSinceMs: number | null = null;
  let hasReachedReadyOnce = false;
  /** Cap on same-session reconnect attempts: explicit option, else budget-driven once ready. */
  const maxAutoReconnectAttemptsLimit = (): number =>
    options.maxAutoReconnectAttempts ??
    (hasReachedReadyOnce ? Number.POSITIVE_INFINITY : 4);
  /** Wall-clock start of the current transport outage (null when healthy). */
  let outageStartMs: number | null = null;
  let outageRecoveryVia: "ice-restart" | "reconnect" = "ice-restart";
  /** True once the live PC is gone or ICE itself was lost, so "ready" means recovered. */
  let outageRestoreEligible = false;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let iceDisconnectedTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let deadPairsTimer: ReturnType<typeof setInterval> | undefined;
  /** The current reconnect attempt's candidate pairs have all failed; it cannot connect. */
  let replacementIceDead = false;
  /** Socket of the current reconnect attempt once it joined (cleared when the next attempt is scheduled). */
  let reconnectJoinedWs: WebSocket | null = null;
  /** True while an in-flight attempt runs on after the budget ended. */
  let inflightGraceActive = false;
  let awaitingReconnectedCallback = false;
  let lastReconnectAttemptForCallback = 0;
  let lastReconnectReason: string | undefined;
  const readinessProfile = resolveReadinessProfile({
    requestMic: options.requestMic,
    readiness: options.readiness,
  });

  const connectionSnapshot: WebRtcConnectionSnapshot = {
    signalingJoined: false,
    peerConnectionState: "new",
    iceConnectionState: "new",
    inboundAudioTrack: false,
    outboundAudioTrack: false,
    controlChannelOpen: false,
    syncChannelOpen: false,
  };

  const publishConnectionStatus = (): void => {
    options.onConnectionStatus?.(
      buildWebRtcConnectionStatus(connectionSnapshot, readinessProfile),
    );
  };

  const syncOutboundAudioTrack = (): void => {
    if (!micStream) {
      updateConnectionSnapshot({ outboundAudioTrack: false });
      return;
    }
    const hasLiveTrack = micStream
      .getAudioTracks()
      .some((track) => track.readyState === "live");
    updateConnectionSnapshot({
      outboundAudioTrack: hasLiveTrack,
    });
  };

  const disposeCurrentMic = (): void => {
    disposeMicHandle?.();
    disposeMicHandle = null;
    micStream = null;
    audioInputDeviceId = null;
  };

  const applyMicAcquisition = (
    result: Awaited<ReturnType<typeof acquireAudioInput>>,
  ): void => {
    disposeCurrentMic();
    micStream = result.stream;
    audioInputState = result.state;
    audioInputDeviceId = result.deviceId;
    disposeMicHandle = result.dispose;
  };

  const restartMicPumpIfConnected = (): void => {
    stopMicPump?.();
    stopMicPump = null;
    const localPc = pc;
    if (
      !micStream ||
      !localPc ||
      localPc.connectionState !== "connected" ||
      (options.micPump ?? "silent") !== "silent"
    ) {
      return;
    }
    stopMicPump = createMicPump(
      micStream,
      () => pc === localPc && localPc.connectionState === "connected",
      debug,
    );
  };

  const replaceMicOnSender = async (nextStream: MediaStream): Promise<void> => {
    const nextTrack = nextStream.getAudioTracks()[0] ?? null;
    if (micRtpSender) {
      await micRtpSender.replaceTrack(nextTrack);
      return;
    }
    const localPc = pc;
    if (localPc && nextTrack) {
      micRtpSender = await attachMicTracks(localPc, nextStream);
    }
  };

  const switchAudioInput = async (
    deviceId: string | null,
    options?: { reRequest?: boolean },
  ): Promise<boolean> => {
    const getUserMedia = runtime.getUserMedia;
    const result = await acquireAudioInput({
      getUserMedia,
      deviceId,
    });
    if (result.state !== "live" && options?.reRequest) {
      result.dispose();
      return false;
    }
    applyMicAcquisition(result);
    if (result.state === "live") {
      debug?.info("voice", "mic_granted");
    } else if (result.state === "denied") {
      debug?.info("voice", "mic_denied");
      debug?.info("voice", "mic_synthetic_fallback");
    } else {
      debug?.info("voice", "mic_synthetic_fallback");
    }
    await replaceMicOnSender(result.stream);
    syncOutboundAudioTrack();
    restartMicPumpIfConnected();
    return result.state === "live";
  };

  const tryResolveConnected = (): void => {
    if (!isWebRtcConnectionReady(connectionSnapshot, readinessProfile)) return;
    pendingConnectFailure = null;
    if (awaitingReconnectedCallback && hasReachedReadyOnce) {
      options.onReconnected?.(lastReconnectAttemptForCallback, reconnectInfo());
      awaitingReconnectedCallback = false;
      lastReconnectReason = undefined;
    }
    hasReachedReadyOnce = true;
    resolveConnected?.();
    // Success path must drop waiter handles immediately (not only timeout/reject).
    clearConnectedWait();
  };

  const updateConnectionSnapshot = (
    patch: Partial<WebRtcConnectionSnapshot>,
  ): void => {
    Object.assign(connectionSnapshot, patch);
    markRestoredIfRecovered();
    publishConnectionStatus();
    tryResolveConnected();
  };

  const notifySessionError = (event: SessionErrorEvent) => {
    emitSessionError(options.onSessionError, event);
  };

  const markTerminalRemoteSessionError = (event: SessionErrorEvent): void => {
    if (event.recoverable === false) {
      gracefulDisconnect = true;
    }
  };

  const handleControlPayload = (message: Record<string, unknown>) => {
    if (isSessionErrorEvent(message)) {
      notifySessionError(message);
      markTerminalRemoteSessionError(message);
      return;
    }
    const legacy = parseLegacyAgentError(message, orchestratorSessionId);
    if (legacy) {
      notifySessionError(legacy);
      markTerminalRemoteSessionError(legacy);
      return;
    }
    if (message.type === "session_reconnect_token") {
      const token =
        typeof message.token === "string" ? message.token.trim() : "";
      if (!token) {
        debug?.warn("session", "reconnect_token_rejected", "empty token");
        return;
      }
      joinCredentials.join_token = token;
      if (
        typeof message.expiresAt === "string" &&
        message.expiresAt.length > 0
      ) {
        joinCredentials.expires_at = message.expiresAt;
      }
      signalingUrl = rebuildSignalingUrl();
      debug?.info("session", "reconnect_token_updated");
      const windowMs = message.reconnectWindowMs;
      if (
        options.reconnectBudgetMs === undefined &&
        typeof windowMs === "number" &&
        Number.isFinite(windowMs) &&
        windowMs >= 5_000 &&
        windowMs <= 120_000 &&
        windowMs !== reconnectBudgetMs
      ) {
        reconnectBudgetMs = windowMs;
        debug?.info(
          "session",
          "reconnect_budget",
          `reconnect budget ${windowMs}ms (from server)`,
        );
      }
      options.onControlMessage?.(message);
      return;
    }
    if (message.type === "session_close") {
      gracefulDisconnect = true;
      const closeCode =
        typeof message.code === "string" ? message.code : undefined;
      const closeReason =
        typeof message.reason === "string" ? message.reason : undefined;
      const closeMessage =
        typeof message.message === "string" ? message.message : undefined;
      const idleTimeout =
        closeCode === "idle_timeout" || closeReason === "idle_timeout";
      notifySessionError({
        type: "session_error",
        code: idleTimeout ? "SESSION_IDLE_TIMEOUT" : "WEBRTC_CONNECTION_CLOSED",
        message: idleTimeout
          ? (closeMessage ?? "Session ended due to idle timeout")
          : (closeMessage ?? "WebRTC session closed by server"),
        session_id: orchestratorSessionId,
        recoverable: false,
        occurred_at: new Date().toISOString(),
      });
      debug?.info(
        "session",
        "remote_close",
        closeCode ?? closeReason ?? "unknown",
      );
      connectionState = "closed";
      if (connectionSnapshot.peerConnectionState !== "closed") {
        updateConnectionSnapshot({
          peerConnectionState: "closed",
          controlChannelOpen: false,
          syncChannelOpen: false,
        });
      }
      return;
    }
    options.onControlMessage?.(message);
  };

  const stopDeadPairsProbe = (): void => {
    if (deadPairsTimer) clearInterval(deadPairsTimer);
    deadPairsTimer = undefined;
  };

  const clearRecoveryTimers = (): void => {
    stopDeadPairsProbe();
    replacementIceDead = false;
    if (budgetTimer) clearTimeout(budgetTimer);
    if (iceDisconnectedTimer) clearTimeout(iceDisconnectedTimer);
    if (settleTimer) clearTimeout(settleTimer);
    budgetTimer = undefined;
    iceDisconnectedTimer = undefined;
    settleTimer = undefined;
    inflightGraceActive = false;
  };

  /** The replacement peer connection of a same-session reconnect is still negotiating ICE. */
  const isReplacementPcConnecting = (): boolean => {
    if (outageRecoveryVia !== "reconnect") return false;
    if (replacementIceDead) return false;
    const ice = connectionSnapshot.iceConnectionState;
    const state = connectionSnapshot.peerConnectionState;
    if (
      ice === "failed" ||
      ice === "closed" ||
      state === "failed" ||
      state === "closed"
    ) {
      return false;
    }
    if (
      state === "connected" &&
      !isWebRtcConnectionReady(connectionSnapshot, readinessProfile)
    ) {
      return true;
    }
    return ice === "checking" || state === "connecting";
  };

  /** A reconnect attempt has its signaling socket connecting/open or its peer connecting. */
  const isReconnectAttemptInFlight = (): boolean => {
    if (outageRecoveryVia !== "reconnect") return false;
    if (reconnectFlight !== null) return true;
    if (
      reconnectJoinedWs !== null &&
      reconnectJoinedWs === ws &&
      ws.readyState <= 1
    ) {
      return true;
    }
    return isReplacementPcConnecting();
  };

  /** Terminal recovery failure: stop retrying, tell the integrator, publish `lost`. */
  const failRecovery = (input: {
    code: "WEBRTC_RECONNECT_EXHAUSTED" | "SESSION_ENDED_DURING_RECONNECT";
    errorMessage: string;
    statusMessage: string;
    logName: string;
    logDetail: string;
  }): void => {
    if (gracefulDisconnect) return;
    closeDeferredOldPeerConnections();
    awaitingReconnectedCallback = false;
    debug?.warn("session", input.logName, input.logDetail);
    gracefulDisconnect = true;
    clearRecoveryTimers();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    // Invalidate in-flight reconnect flights and their WebSocket handlers.
    signalingEpoch += 1;
    notifySessionError(
      createLocalSessionError({
        code: input.code,
        message: input.errorMessage,
        sessionId: orchestratorSessionId,
        recoverable: false,
      }),
    );
    rejectConnectedWait(new Error(input.errorMessage), false);
    updateConnectionSnapshot({
      signalingJoined: false,
      controlChannelOpen: false,
      syncChannelOpen: false,
      recovery: {
        state: "lost",
        reason: input.code,
        message: input.statusMessage,
      },
      ...(connectionSnapshot.peerConnectionState !== "closed"
        ? { peerConnectionState: "closed" as const }
        : {}),
    });
  };

  const emitAutoReconnectExhausted = (reason: string): void => {
    const elapsedMs =
      outageStartMs !== null ? Date.now() - outageStartMs : undefined;
    failRecovery({
      code: "WEBRTC_RECONNECT_EXHAUSTED",
      errorMessage: `Auto-reconnect exhausted after ${autoReconnectAttempts} attempts${
        elapsedMs !== undefined ? ` in ${elapsedMs} ms` : ""
      } (${reason})`,
      statusMessage: statusMessages.lost,
      logName: "auto_reconnect_exhausted",
      logDetail: reason,
    });
  };

  const endSessionDuringReconnect = (): void => {
    failRecovery({
      code: "SESSION_ENDED_DURING_RECONNECT",
      errorMessage: statusMessages.sessionEnded,
      statusMessage: statusMessages.sessionEnded,
      logName: "session_ended_during_reconnect",
      logDetail: "reconnect token rejected with HTTP 401",
    });
  };

  /**
   * Start tracking a transport outage (only after the session was ready once).
   * The budget runs from the first loss, not from when recovery work begins.
   */
  const beginOutage = (
    reason: string,
    lossAtMs: number,
    iceLost: boolean,
  ): void => {
    if (!hasReachedReadyOnce || gracefulDisconnect) return;
    if (reconnectPolicy === "new-session") return;
    if (outageStartMs !== null) return;
    outageStartMs = lossAtMs;
    outageRecoveryVia = "ice-restart";
    outageRestoreEligible = iceLost;
    const remainingMs = Math.max(
      0,
      reconnectBudgetMs - (Date.now() - lossAtMs),
    );
    budgetTimer = setTimeout(() => {
      budgetTimer = undefined;
      if (isReconnectAttemptInFlight()) {
        // Let the attempt that is about to connect finish; never start another one.
        inflightGraceActive = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        debug?.warn(
          "session",
          "reconnect_inflight_grace",
          `attempt=${autoReconnectAttempts} grace_ms=${RECONNECT_INFLIGHT_GRACE_MS}`,
        );
        budgetTimer = setTimeout(() => {
          budgetTimer = undefined;
          inflightGraceActive = false;
          emitAutoReconnectExhausted("budget_exhausted");
        }, RECONNECT_INFLIGHT_GRACE_MS);
        return;
      }
      emitAutoReconnectExhausted("budget_exhausted");
    }, remainingMs);
    debug?.warn("session", "transport_lost", reason);
    updateConnectionSnapshot({
      recovery: {
        state: "interrupted",
        sinceMs: Date.now() - lossAtMs,
        message: statusMessages.interrupted,
      },
    });
  };

  /** Called from {@link updateConnectionSnapshot}; assigns `recovery` without publishing. */
  const markRestoredIfRecovered = (): void => {
    if (outageStartMs === null || gracefulDisconnect) return;
    if (!outageRestoreEligible) return;
    if (!isWebRtcConnectionReady(connectionSnapshot, readinessProfile)) return;
    const ice = connectionSnapshot.iceConnectionState;
    if (ice === "disconnected" || ice === "failed" || ice === "closed") return;
    const downtimeMs = Date.now() - outageStartMs;
    outageStartMs = null;
    outageRestoreEligible = false;
    clearRecoveryTimers();
    // The session is back: an attempt still waiting to start would replace a healthy connection.
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      debug?.info(
        "session",
        "reconnect_cancelled",
        `restored_before_attempt via=${outageRecoveryVia} attempt=${autoReconnectAttempts}`,
      );
    }
    debug?.info(
      "session",
      "transport_restored",
      `downtime_ms=${downtimeMs} via=${outageRecoveryVia}`,
    );
    connectionSnapshot.recovery = {
      state: "restored",
      downtimeMs,
      via: outageRecoveryVia,
      message: statusMessages.restored,
    };
  };

  const clearIceDisconnectedTimer = (): void => {
    if (iceDisconnectedTimer) clearTimeout(iceDisconnectedTimer);
    iceDisconnectedTimer = undefined;
  };

  /**
   * While a reconnect attempt settles, watch its candidate pairs. When every pair
   * has failed (twice in a row) the attempt cannot connect: replace it right away.
   */
  const startDeadPairsProbe = (): void => {
    stopDeadPairsProbe();
    // The rejoin socket opens before the server offer creates the replacement
    // peer connection, so at arm time `pc` is still the pre-attempt one.
    const startPc = pc;
    let targetPc: RTCPeerConnection | null = null;
    let deadCount = 0;
    let probing = false;
    const shouldStop = (): boolean =>
      gracefulDisconnect ||
      outageStartMs === null ||
      outageRecoveryVia !== "reconnect";
    const probe = async (): Promise<void> => {
      if (probing) return;
      probing = true;
      try {
        if (shouldStop()) {
          stopDeadPairsProbe();
          return;
        }
        const current = pc;
        // Replacement not created yet (or being swapped): nothing to judge.
        if (!current || current === startPc) return;
        if (current !== targetPc) {
          targetPc = current;
          deadCount = 0;
        }
        let diagnostics: WebRtcDiagnostics | null = null;
        try {
          diagnostics = await collectWebRtcDiagnostics(
            current,
            buildWebRtcConnectionStatus(connectionSnapshot, readinessProfile),
          );
        } catch {
          return;
        }
        if (shouldStop()) {
          stopDeadPairsProbe();
          return;
        }
        if (pc !== current) return;
        const s = diagnostics?.stats;
        if (s && s.candidatePairs > 0 && s.failedPairs === s.candidatePairs) {
          deadCount += 1;
        } else {
          deadCount = 0;
        }
        if (!s || deadCount < RECONNECT_DEAD_PAIRS_CONFIRM) return;
        stopDeadPairsProbe();
        replacementIceDead = true;
        debug?.warn(
          "session",
          "reconnect_attempt_ice_failed",
          `attempt=${autoReconnectAttempts} pairs=${s.candidatePairs}`,
        );
        if (inflightGraceActive) {
          emitAutoReconnectExhausted("reconnect_ice_failed");
          return;
        }
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = undefined;
        scheduleAutoReconnect("reconnect_ice_failed");
      } finally {
        probing = false;
      }
    };
    deadPairsTimer = setInterval(() => {
      void probe();
    }, RECONNECT_DEAD_PAIRS_PROBE_MS);
  };

  /** Escalate when a recovery rejoin does not reach readiness in time. */
  const armSettleTimer = (
    ms: number,
    reason: string,
    canExtend = true,
  ): void => {
    if (outageStartMs === null || gracefulDisconnect) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (outageStartMs === null || gracefulDisconnect) return;
      if (canExtend && !inflightGraceActive && isReplacementPcConnecting()) {
        const budgetLeftMs = outageStartMs + reconnectBudgetMs - Date.now();
        if (budgetLeftMs > 0) {
          debug?.info(
            "session",
            "reconnect_settle_extended",
            `reconnect attempt ${autoReconnectAttempts} still connecting — extending settle`,
          );
          armSettleTimer(
            Math.min(RECONNECT_SETTLE_EXTEND_MS, budgetLeftMs),
            reason,
            false,
          );
          return;
        }
      }
      debug?.warn("session", "recovery_settle_timeout", reason);
      scheduleAutoReconnect(`${reason}_timeout`);
    }, ms);
    if (reason === "reconnect" && canExtend) startDeadPairsProbe();
  };

  /** ICE/PC `disconnected`: start recovery if it lasts longer than the grace period. */
  const noteIceDisconnected = (localPc: RTCPeerConnection): void => {
    if (!hasReachedReadyOnce || gracefulDisconnect) return;
    if (reconnectPolicy === "new-session") return;
    if (iceDisconnectedTimer || outageStartMs !== null) return;
    const lossAtMs = Date.now();
    iceDisconnectedTimer = setTimeout(() => {
      iceDisconnectedTimer = undefined;
      if (pc !== localPc || gracefulDisconnect) return;
      beginOutage("ice_disconnected", lossAtMs, true);
      // Keep the old peer alive: a rejoin replaces it on the server. Wait for it to
      // come back on its own until the connection has been disconnected long enough.
      const waitMs = Math.max(
        0,
        lossAtMs + rejoinAfterDisconnectedMs - Date.now(),
      );
      iceDisconnectedTimer = setTimeout(() => {
        iceDisconnectedTimer = undefined;
        if (pc !== localPc || gracefulDisconnect) return;
        startRecovery("ice_disconnected");
      }, waitMs);
    }, ICE_DISCONNECTED_GRACE_MS);
  };

  const startRecovery = (reason: string): void => {
    if (gracefulDisconnect || reconnectPolicy === "new-session") return;
    // The first action is the same-session reconnect; the relay ICE recovery
    // (scheduleIceRecovery) only serves the stuck-checking path on first connect.
    if (canAutoReconnectTransport()) {
      scheduleAutoReconnect(reason);
    } else {
      emitAutoReconnectExhausted(reason);
    }
  };

  const ensureConnectedPromise = (): Promise<void> => {
    if (!connectedPromise) {
      connectedPromise = new Promise<void>((resolve, reject) => {
        resolveConnected = resolve;
        rejectConnected = reject;
      });
      void connectedPromise.catch(() => undefined);
    }
    return connectedPromise;
  };

  const clearConnectedWait = (): void => {
    connectedPromise = null;
    resolveConnected = null;
    rejectConnected = null;
  };

  const canAutoReconnectTransport = (): boolean => {
    if (gracefulDisconnect || reconnectPolicy === "new-session") return false;
    return autoReconnectAttempts < maxAutoReconnectAttemptsLimit();
  };

  const reconnectInfo = (reason?: string): VoiceSessionReconnectInfo => ({
    reason: reason ?? lastReconnectReason ?? "unknown",
    iceTransportPolicy: effectiveIceTransportPolicy,
  });

  const canIceRecover = (): boolean => {
    if (gracefulDisconnect || reconnectPolicy === "new-session") return false;
    if (maxIceRecoveryAttempts <= 0) return false;
    return iceRecoveryAttempts < maxIceRecoveryAttempts;
  };

  const stopIceStuckWatch = (): void => {
    if (iceStuckWatchTimer) {
      clearInterval(iceStuckWatchTimer);
      iceStuckWatchTimer = undefined;
    }
    iceCheckingSinceMs = null;
  };

  const scheduleIceRecovery = (reason: string): void => {
    if (gracefulDisconnect || reconnectPolicy === "new-session") return;
    clearIceDisconnectedTimer();
    if (!canIceRecover()) {
      if (canAutoReconnectTransport()) {
        scheduleAutoReconnect(reason);
      }
      return;
    }
    iceRecoveryAttempts += 1;
    // The relay recovery rejoins the same session: report it like any same-session reconnect.
    lastReconnectAttemptForCallback = iceRecoveryAttempts;
    awaitingReconnectedCallback = true;
    if (effectiveIceTransportPolicy !== "relay") {
      effectiveIceTransportPolicy = "relay";
    }
    lastReconnectReason = reason;
    options.onIceRecovery?.(iceRecoveryAttempts, reconnectInfo(reason));
    debug?.info(
      "session",
      "ice_recovery_relay",
      `${reason} attempt=${iceRecoveryAttempts}`,
    );
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void reconnectSignaling(true)
        .then(() => armSettleTimer(ICE_RECOVERY_SETTLE_MS, "ice_recovery"))
        .catch((error: unknown) => {
          if (error instanceof SessionEndedDuringReconnectError) {
            endSessionDuringReconnect();
            return;
          }
          debug?.warn(
            "session",
            "ice_recovery_failed",
            error instanceof Error ? error.message : String(error),
          );
          if (canAutoReconnectTransport()) {
            scheduleAutoReconnect(reason);
          }
        });
    }, 0);
  };

  const triggerIceStuckRecovery = async (checkingMs: number): Promise<void> => {
    if (!canIceRecover() || gracefulDisconnect) return;
    stopIceStuckWatch();
    debug?.warn("session", "ice_stuck_checking", `checking_ms=${checkingMs}`);
    notifySessionError({
      type: "session_error",
      code: "WEBRTC_CONNECTION_FAILED",
      message: `WebRTC ICE stuck checking (nominated=0, checking_ms=${checkingMs})`,
      session_id: orchestratorSessionId,
      recoverable: canIceRecover() || canAutoReconnectTransport(),
      occurred_at: new Date().toISOString(),
    });
    rejectConnectedWait(new Error("peer connection ice stuck checking"), true);
    await retirePeerConnection({
      preserveConnectedWait: true,
      deferClose: true,
    });
    scheduleIceRecovery("ice_stuck_checking");
  };

  const checkIceStuck = async (
    localPc: RTCPeerConnection,
    isPcCurrent: () => boolean,
  ): Promise<void> => {
    if (!isPcCurrent() || gracefulDisconnect) {
      stopIceStuckWatch();
      return;
    }
    const pcState = localPc.connectionState ?? "new";
    const iceState = localPc.iceConnectionState ?? "new";
    if (
      pcState === "connected" ||
      pcState === "failed" ||
      pcState === "closed"
    ) {
      stopIceStuckWatch();
      return;
    }
    const stuckEligible =
      iceState === "checking" || iceState === "new" || pcState === "connecting";
    if (!stuckEligible) {
      iceCheckingSinceMs = null;
      return;
    }
    const now = Date.now();
    iceCheckingSinceMs ??= now;
    if (now - iceCheckingSinceMs < iceRecoveryStuckCheckingMs) return;
    if (!canIceRecover()) return;

    let diagnostics: WebRtcDiagnostics | null = null;
    try {
      diagnostics = await collectWebRtcDiagnostics(
        localPc,
        buildWebRtcConnectionStatus(connectionSnapshot, readinessProfile),
      );
    } catch {
      return;
    }
    if (!diagnostics || !isPcCurrent()) return;
    const s = diagnostics.stats;
    if (s.nominatedPairs !== 0 || s.selectedPairId) return;
    const gatheringDone = diagnostics.iceGatheringState === "complete";
    if (!(s.succeededPairs > 0 || s.candidatePairs > 0 || gatheringDone)) {
      return;
    }
    await triggerIceStuckRecovery(now - iceCheckingSinceMs);
  };

  const startIceStuckWatch = (
    localPc: RTCPeerConnection,
    isPcCurrent: () => boolean,
  ): void => {
    if (iceRecoveryStuckCheckingMs <= 0) return;
    stopIceStuckWatch();
    iceStuckWatchTimer = setInterval(() => {
      void checkIceStuck(localPc, isPcCurrent);
    }, 1000);
  };

  const rejectConnectedWait = (error: Error, retriable: boolean): void => {
    const wrapped = retriable
      ? new WebRtcConnectRetryError(error.message)
      : error;
    if (!retriable) {
      pendingConnectFailure = wrapped;
    }
    rejectConnected?.(wrapped);
    clearConnectedWait();
  };

  const handleTransportFailure = (
    state: "failed" | "closed",
    reconnectReason: "webrtc_failed" | "webrtc_closed",
  ): void => {
    stopMicPump?.();
    stopMicPump = null;
    clearIceDisconnectedTimer();
    beginOutage(reconnectReason, Date.now(), state === "failed");
    if (!gracefulDisconnect) {
      if (state === "failed") {
        notifySessionError({
          type: "session_error",
          code: "WEBRTC_CONNECTION_FAILED",
          message: "WebRTC peer connection failed",
          session_id: orchestratorSessionId,
          recoverable: canIceRecover() || canAutoReconnectTransport(),
          occurred_at: new Date().toISOString(),
        });
      } else {
        notifySessionError({
          type: "session_error",
          code: "WEBRTC_CONNECTION_CLOSED",
          message: "WebRTC peer connection closed unexpectedly",
          session_id: orchestratorSessionId,
          recoverable: canIceRecover() || canAutoReconnectTransport(),
          occurred_at: new Date().toISOString(),
        });
      }
    }

    stopIceStuckWatch();
    const retriable = canIceRecover() || canAutoReconnectTransport();
    rejectConnectedWait(new Error(`peer connection ${state}`), retriable);
    // A dropped, previously ready session reconnects directly (no relay detour) so it
    // fits the platform's 15 s window; relay ICE recovery stays for the first connect.
    if (!hasReachedReadyOnce && canIceRecover()) {
      scheduleIceRecovery(reconnectReason);
    } else if (retriable) {
      scheduleAutoReconnect(reconnectReason);
    } else if (
      !gracefulDisconnect &&
      maxAutoReconnectAttemptsLimit() > 0 &&
      autoReconnectAttempts >= maxAutoReconnectAttemptsLimit()
    ) {
      emitAutoReconnectExhausted(reconnectReason);
    }
  };

  const sendSignal = (message: Record<string, unknown>) => {
    if (ws?.readyState === runtime.WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const sendToServer = (payload: Record<string, unknown>) => {
    sendSignal({ room: roomId, peerId, ...payload });
  };

  const dispatchBinary = (data: ArrayBuffer, channel: DataChannelKind) => {
    debug?.debug("dc", "binary", `${channel}:${data.byteLength}b`);
    if (channel === "sync") {
      options.onSyncBinaryMessage?.(data);
      return;
    }
    options.onBinaryMessage?.(data);
  };

  const handleControlJson = (raw: string) => {
    debug?.debug("dc", "message", raw);
    try {
      const message = JSON.parse(raw) as Record<string, unknown> & {
        type?: string;
        event?: string;
        text?: string;
      };
      handleControlPayload(message);
      if (message.type === "speech_event") {
        debug?.info("speech", message.event ?? "event", message.text);
      } else if (
        message.type !== "session_error" &&
        message.type !== "agent_error" &&
        message.type !== "session_close" &&
        message.type !== "session_reconnect_token"
      ) {
        logDcMessage(debug, message.type ?? "json", message.text);
      }
    } catch {
      debug?.warn("dc", "malformed", raw);
    }
  };

  const wireBinaryChannel = (
    channel: RTCDataChannel,
    kind: DataChannelKind,
    isChannelCurrent: () => boolean,
  ) => {
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event) => {
      if (!isChannelCurrent()) return;
      if (typeof event.data === "string") {
        if (kind === "control") {
          handleControlJson(String(event.data));
        }
        return;
      }
      const buf: ArrayBuffer =
        event.data instanceof ArrayBuffer
          ? event.data
          : (() => {
              const view = event.data as ArrayBufferView;
              const copy = new ArrayBuffer(view.byteLength);
              new Uint8Array(copy).set(
                new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
              );
              return copy;
            })();
      dispatchBinary(buf, kind);
    };
  };

  if (options.requestMic !== false) {
    const result = await acquireAudioInput({
      getUserMedia: runtime.getUserMedia,
      deviceId: options.audioInputDeviceId,
    });
    applyMicAcquisition(result);
    if (result.state === "live") {
      debug?.info("voice", "mic_granted");
    } else if (result.state === "denied") {
      debug?.info("voice", "mic_denied");
      debug?.info("voice", "mic_synthetic_fallback");
    } else {
      debug?.info("voice", "mic_synthetic_fallback");
    }
    syncOutboundAudioTrack();
  }

  /**
   * Retire the current PC with the awaitable close barrier.
   * Callers that will create a replacement must abort when status is not `closed`.
   * On timed_out/failed, quarantine and block all future replacements.
   */
  const retirePeerConnection = async (retireOptions?: {
    preserveConnectedWait?: boolean;
    /** Recovery: detach the old PC but keep it open until the replacement connects. */
    deferClose?: boolean;
  }): Promise<PeerCloseResult> => {
    if (replacementBlockedResult) {
      return replacementBlockedResult;
    }
    stopMicPump?.();
    stopMicPump = null;
    clearIceDisconnectedTimer();
    if (outageStartMs !== null) outageRestoreEligible = true;
    controlChannel = null;
    syncChannel = null;
    const localPc = pc;
    activePcGeneration = 0;
    clearPendingIceGenerations();
    connectionState = "new";
    if (!retireOptions?.preserveConnectedWait) {
      connectedPromise = null;
      resolveConnected = null;
      rejectConnected = null;
      pendingConnectFailure = null;
    }
    updateConnectionSnapshot({
      peerConnectionState: "new",
      iceConnectionState: "new",
      inboundAudioTrack: false,
      outboundAudioTrack: false,
      controlChannelOpen: false,
      syncChannelOpen: false,
    });
    if (!localPc) {
      return {
        status: "closed",
        mode: "sync",
        durationMs: 0,
        timedOut: false,
      };
    }
    intentionallyRetiringPcs.add(localPc);
    micRtpSender = null;
    // Detach from live slot before awaiting close so handlers see identity change.
    pc = null;
    if (retireOptions?.deferClose) {
      localPc.ontrack = null;
      localPc.ondatachannel = null;
      localPc.onicecandidate = null;
      localPc.oniceconnectionstatechange = null;
      localPc.onicegatheringstatechange = null;
      deferredOldPcs.push(localPc);
      return {
        status: "closed",
        mode: "sync",
        durationMs: 0,
        timedOut: false,
      };
    }
    const closeResult = await closePeerConnectionAwaitable(localPc);
    if (closeResult.status !== "closed") {
      // Never invent closed later — retain unsafe PC, block replacement forever.
      replacementBlockedResult = closeResult;
      quarantinedPc = localPc;
      terminalDisconnectResult = closeResult;
      return closeResult;
    }
    return closeResult;
  };

  const bindDataChannel = (
    channel: RTCDataChannel,
    binding: {
      kind: DataChannelKind;
      label: string;
      openField: "controlChannelOpen" | "syncChannelOpen";
      getAssigned: () => RTCDataChannel | null;
      assign: (next: RTCDataChannel | null) => void;
      onOpen?: (channel: RTCDataChannel) => void;
    },
    isPcCurrent: () => boolean,
  ): void => {
    binding.assign(channel);
    const isChannelCurrent = (): boolean =>
      isPcCurrent() && binding.getAssigned() === channel;

    const markOpen = () => {
      if (!isChannelCurrent()) return;
      updateConnectionSnapshot({ [binding.openField]: true });
    };

    channel.onopen = () => {
      if (!isChannelCurrent()) return;
      debug?.info("dc", "open", binding.label);
      markOpen();
      binding.onOpen?.(channel);
    };
    if (channel.readyState === "open") markOpen();

    channel.onclose = () => {
      if (!isChannelCurrent()) return;
      debug?.info("dc", "close", binding.label);
      binding.assign(null);
      updateConnectionSnapshot({ [binding.openField]: false });
    };

    channel.onerror = () => {
      if (!isChannelCurrent()) return;
      debug?.warn("dc", "error", binding.label);
    };

    wireBinaryChannel(channel, binding.kind, isChannelCurrent);
  };

  const wireControl = (channel: RTCDataChannel, isPcCurrent: () => boolean) => {
    bindDataChannel(
      channel,
      {
        kind: "control",
        label: VOICE_CONTROL_CHANNEL_LABEL,
        openField: "controlChannelOpen",
        getAssigned: () => controlChannel,
        assign: (next) => {
          controlChannel = next;
        },
        onOpen: (openChannel) => {
          if (!options.customerContext) return;
          openChannel.send(
            JSON.stringify({
              type: "session_hello",
              customer_context: options.customerContext,
            }),
          );
        },
      },
      isPcCurrent,
    );
  };

  const wireSync = (channel: RTCDataChannel, isPcCurrent: () => boolean) => {
    bindDataChannel(
      channel,
      {
        kind: "sync",
        label: VOICE_SYNC_CHANNEL_LABEL,
        openField: "syncChannelOpen",
        getAssigned: () => syncChannel,
        assign: (next) => {
          syncChannel = next;
        },
      },
      isPcCurrent,
    );
  };

  const onServerOffer = async (
    sdp: RTCSessionDescriptionInit,
    offerGeneration: number,
  ) => {
    let step = "reset_peer_connection";
    const startedAtMs = Date.now();
    const logOfferStep = (name: string): void => {
      debug?.info(
        "signaling",
        "offer_step",
        `${name} elapsed_ms=${Date.now() - startedAtMs}`,
      );
    };
    const isOfferCurrent = (): boolean =>
      offerGeneration === negotiationGeneration && !gracefulDisconnect;

    try {
      if (!isOfferCurrent()) return;
      assertReplacementAllowed();

      if (pc) {
        step = "await_previous_peer_close";
        const closeResult = await retirePeerConnection({
          preserveConnectedWait: true,
        });
        emitDiagnosticSafely(options.onDiagnosticEvent, {
          type: "peer_close",
          status: closeResult.status,
          mode: closeResult.mode,
          durationMs: closeResult.durationMs,
          timedOut: closeResult.timedOut,
          context: "offer_replace",
          ...(closeResult.error !== undefined
            ? { error: redactDiagnosticDetail(closeResult.error) }
            : {}),
        });
        if (!isOfferCurrent()) return;
        if (closeResult.status !== "closed") {
          throw new Error(
            `cannot replace peer connection: previous close ${closeResult.status}`,
          );
        }
      }
      logOfferStep(step);
      assertReplacementAllowed();

      step = "create_peer_connection";
      ensureConnectedPromise();
      const localPc = new runtime.RTCPeerConnection({
        iceServers,
        ...(effectiveIceTransportPolicy
          ? { iceTransportPolicy: effectiveIceTransportPolicy }
          : {}),
      });
      pc = localPc;
      activePcGeneration = offerGeneration;
      const boundGeneration = offerGeneration;
      const isPcCurrent = (): boolean =>
        pc === localPc &&
        activePcGeneration === boundGeneration &&
        offerGeneration === negotiationGeneration &&
        !gracefulDisconnect &&
        !replacementBlockedResult;
      logOfferStep(step);

      localPc.ontrack = (event) => {
        if (!isPcCurrent()) return;
        if (event.track.kind !== "audio") return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        if (playbackAudioElement) {
          playbackAudioElement.srcObject = stream;
          void attemptInboundAudioPlayback();
        }
        options.onAgentAudioTrack?.(event.track);
        updateConnectionSnapshot({ inboundAudioTrack: true });
        debug?.info("webrtc", "agent_audio_track");
      };

      localPc.ondatachannel = (event) => {
        if (!isPcCurrent()) return;
        if (event.channel.label === VOICE_CONTROL_CHANNEL_LABEL) {
          wireControl(event.channel, isPcCurrent);
        } else if (event.channel.label === VOICE_SYNC_CHANNEL_LABEL) {
          wireSync(event.channel, isPcCurrent);
        }
      };

      localPc.onicecandidate = (event) => {
        if (!isPcCurrent()) return;
        if (event.candidate) {
          try {
            const candidate = event.candidate.toJSON?.() ?? {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              usernameFragment: event.candidate.usernameFragment,
            };
            sendToServer({
              type: "ice-candidate",
              targetPeerId: VOICE_AGENT_SERVER_PEER_ID,
              candidate,
            });
          } catch (error: unknown) {
            const detail =
              error instanceof Error ? error.message : String(error);
            debug?.warn("signaling", "ice_candidate_send_failed", detail);
          }
        }
      };

      localPc.onconnectionstatechange = () => {
        const intentionalRetire = intentionallyRetiringPcs.has(localPc);
        // Per-PC identity: never let a retired/stale PC mutate live globals.
        if (pc !== localPc) {
          return;
        }
        if (!isPcCurrent() && !intentionalRetire) return;
        connectionState = localPc.connectionState ?? "new";
        debug?.info("webrtc", "connection_state", connectionState);
        updateConnectionSnapshot({ peerConnectionState: connectionState });
        if (connectionState === "connected") {
          if (!isPcCurrent()) return;
          closeDeferredOldPeerConnections();
          clearIceDisconnectedTimer();
          autoReconnectAttempts = 0;
          iceRecoveryAttempts = 0;
          stopIceStuckWatch();
          stopMicPump?.();
          stopMicPump = null;
          if (micStream && (options.micPump ?? "silent") === "silent") {
            stopMicPump = createMicPump(
              micStream,
              () => pc === localPc && localPc.connectionState === "connected",
              debug,
            );
          }
          syncOutboundAudioTrack();
        } else if (connectionState === "disconnected") {
          if (!isPcCurrent()) return;
          noteIceDisconnected(localPc);
        } else if (connectionState === "failed") {
          if (!isPcCurrent()) return;
          handleTransportFailure("failed", "webrtc_failed");
        } else if (connectionState === "closed") {
          if (intentionalRetire || gracefulDisconnect) {
            if (gracefulDisconnect) {
              rejectConnectedWait(
                new Error(`peer connection ${connectionState}`),
                false,
              );
            }
            return;
          }
          if (!isPcCurrent()) return;
          handleTransportFailure("closed", "webrtc_closed");
        }
      };

      localPc.oniceconnectionstatechange = () => {
        if (!isPcCurrent()) return;
        const iceConnectionState = localPc.iceConnectionState ?? "new";
        debug?.info("webrtc", "ice_connection_state", iceConnectionState);
        if (iceConnectionState === "disconnected") {
          noteIceDisconnected(localPc);
        } else if (
          iceConnectionState === "connected" ||
          iceConnectionState === "completed"
        ) {
          clearIceDisconnectedTimer();
        }
        updateConnectionSnapshot({ iceConnectionState });
      };

      localPc.onicegatheringstatechange = () => {
        if (!isPcCurrent()) return;
        debug?.info(
          "webrtc",
          "ice_gathering_state",
          localPc.iceGatheringState ?? "unknown",
        );
      };

      if (micStream) {
        step = "attach_mic";
        micRtpSender = await attachMicTracks(localPc, micStream);
        if (!isPcCurrent()) return;
        syncOutboundAudioTrack();
        if ((options.micPump ?? "silent") === "external") {
          for (const track of micStream.getAudioTracks()) {
            if (isWriteSampleTrack(track)) {
              void track
                .writeSample(new Uint8Array(960), 5)
                .catch(() => undefined);
              debug?.info("voice", "mic_kick_sent");
            }
          }
        }
        logOfferStep(step);
      }

      step = "set_remote_description";
      if (!isOfferCurrent() || !isPcCurrent()) return;
      if (!remoteOfferHasIceUfrag(sdp)) {
        throw new Error(
          "set_remote_description called with no ice-ufrag (remote offer missing a=ice-ufrag)",
        );
      }
      await localPc.setRemoteDescription(sdp);
      if (!isOfferCurrent() || !isPcCurrent()) return;
      logOfferStep(step);

      step = "drain_pending_ice";
      if (!isOfferCurrent() || !isPcCurrent()) return;
      await drainPendingIce(localPc, offerGeneration);
      logOfferStep(step);

      step = "create_answer";
      if (!isOfferCurrent() || !isPcCurrent()) return;
      const answer = await localPc.createAnswer();
      if (!isOfferCurrent() || !isPcCurrent()) return;
      logOfferStep(step);

      step = "set_local_description";
      await localPc.setLocalDescription(answer);
      if (!isOfferCurrent() || !isPcCurrent()) return;
      logOfferStep(step);

      const iceAnswerPolicy = runtime.iceAnswerPolicy ?? "trickle-immediate";

      if (iceAnswerPolicy === "wait-gathering") {
        step = "wait_ice_gathering";
        const gatherer = localPc as RTCPeerConnection & {
          gatheringComplete?: () => Promise<void>;
        };
        if (typeof gatherer.gatheringComplete === "function") {
          await gatherer.gatheringComplete();
        } else {
          await waitForIceGatheringComplete(localPc);
        }
        if (!isOfferCurrent() || !isPcCurrent()) return;
        logOfferStep(step);
      }

      // trickle-immediate (browser default): send the answer immediately — do NOT
      // wait for ICE gathering. Waiting races TURN CreatePermission on the runner:
      // Chrome starts connectivity checks right after setLocalDescription, but the
      // runner only learns our srflx/relay (and installs TURN permissions) after the
      // answer + trickle candidates arrive. Hosting many host/IPv6/TURN gathers can
      // delay gathering-complete past Chrome's ICE failure (~15–20s) → every pair
      // shows STUN sent / 0 responses (relay↔relay included). Trickle
      // `onicecandidate` already ships candidates; the runner queues them until
      // setRemoteDescription(answer).
      step = "send_answer";
      const answerSdp = toSessionDescriptionInit(localPc.localDescription);
      if (!answerSdp) {
        throw new Error(
          "set_local_description produced no localDescription for answer",
        );
      }
      sendToServer({
        type: "answer",
        targetPeerId: VOICE_AGENT_SERVER_PEER_ID,
        sdp: answerSdp,
      });
      debug?.info("signaling", "answer_sent");
      logOfferStep(step);
      startIceStuckWatch(localPc, isPcCurrent);

      if (iceAnswerPolicy === "trickle-immediate") {
        // Best-effort: surface gather completion in debug logs (non-blocking).
        void waitForIceGatheringComplete(localPc)
          .then(() => {
            if (!isOfferCurrent() || !isPcCurrent()) return;
            debug?.info("webrtc", "ice_gathering_complete");
            logOfferStep("wait_ice_gathering");
          })
          .catch((error: unknown) => {
            if (!isOfferCurrent() || !isPcCurrent()) return;
            const detail =
              error instanceof Error ? error.message : String(error);
            debug?.warn("webrtc", "ice_gathering_wait_failed", detail);
          });
      }
    } catch (error: unknown) {
      if (!isOfferCurrent()) return;
      const detail = error instanceof Error ? error.message : String(error);
      const message = `WebRTC offer handler failed at ${step}: ${detail}`;
      debug?.error(
        "signaling",
        "offer_handler_failed",
        `${message} elapsed_ms=${Date.now() - startedAtMs}`,
      );
      const retriable = canAutoReconnectTransport();
      notifySessionError(
        createLocalSessionError({
          code: "WEBRTC_SDP_NEGOTIATION_FAILED",
          message,
          sessionId: orchestratorSessionId,
          recoverable: retriable,
        }),
      );
      rejectConnectedWait(new Error(message), retriable);
      // Same as transport failure: waitForConnected alone cannot recover without a
      // fresh PC + offer. Under burst load, empty/malformed offers must trigger
      // same-session signaling reconnect or the client hangs until connect timeout.
      if (retriable) {
        scheduleAutoReconnect("sdp_negotiation_failed");
      }
    }
  };

  /** One active negotiation at a time; newer offers supersede older generations. */
  const enqueueServerOffer = (sdp: RTCSessionDescriptionInit): void => {
    if (replacementBlockedResult) {
      debug?.warn(
        "signaling",
        "offer_ignored_replacement_blocked",
        replacementBlockedResult.status,
      );
      return;
    }
    const offerGeneration = ++negotiationGeneration;
    // Drop ICE buckets from prior generations; keep current gen for early candidates.
    clearPendingIceGenerations(offerGeneration);
    offerChain = offerChain
      .catch(() => undefined)
      .then(() => onServerOffer(sdp, offerGeneration));
    void offerChain.catch(() => undefined);
  };

  const scheduleAutoReconnect = (reason: string): void => {
    if (gracefulDisconnect || reconnectPolicy === "new-session") return;
    // The budget ended while an attempt was connecting: that attempt gets the grace.
    if (inflightGraceActive) return;
    stopDeadPairsProbe();
    reconnectJoinedWs = null;
    clearIceDisconnectedTimer();
    beginOutage(reason, Date.now(), false);
    if (autoReconnectAttempts >= maxAutoReconnectAttemptsLimit()) {
      emitAutoReconnectExhausted(reason);
      return;
    }
    autoReconnectAttempts += 1;
    lastReconnectAttemptForCallback = autoReconnectAttempts;
    awaitingReconnectedCallback = true;
    lastReconnectReason = reason;
    options.onReconnecting?.(autoReconnectAttempts, reconnectInfo(reason));
    const delayMs =
      RECONNECT_BACKOFF_MS[
        Math.min(autoReconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1)
      ];
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = undefined;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      replacementIceDead = false;
      outageRecoveryVia = "reconnect";
      void reconnectSignaling(true)
        .then(() => armSettleTimer(RECONNECT_SETTLE_MS, "reconnect"))
        .catch((error: unknown) => {
          if (error instanceof SessionEndedDuringReconnectError) {
            endSessionDuringReconnect();
            return;
          }
          debug?.warn(
            "session",
            "auto_reconnect_failed",
            error instanceof Error ? error.message : String(error),
          );
          scheduleAutoReconnect(reason);
        });
    }, delayMs);
  };

  type WsCloseDetail = { code?: number; reason?: string; wasClean?: boolean };

  /**
   * One structured line per signaling WebSocket failure (token redacted).
   * `httpStatus` is only known on runtimes that expose the upgrade response (Node `ws`).
   */
  const logSignalingFailure = (input: {
    phase: "connect" | "open";
    url: string;
    startedAtMs: number;
    httpStatus?: number;
    close?: WsCloseDetail;
  }): void => {
    const elapsedMs = Date.now() - (outageStartMs ?? input.startedAtMs);
    const reason =
      input.close?.reason && input.close.reason.length > 0
        ? input.close.reason
        : "n/a";
    debug?.error(
      "signaling",
      "ws_error",
      `signaling ws failed attempt=${autoReconnectAttempts} elapsed=${elapsedMs} phase=${input.phase} code=${
        input.close?.code ?? "n/a"
      } reason=${reason} httpStatus=${input.httpStatus ?? "n/a"} wasClean=${
        input.close?.wasClean ?? "n/a"
      } url=${redactSignalingUrlForLog(input.url)}`,
    );
  };

  const attachWsHandlers = (localWs: WebSocket, boundEpoch: number): void => {
    const isCurrentWs = (): boolean =>
      ws === localWs && boundEpoch === signalingEpoch && !gracefulDisconnect;

    localWs.onmessage = (event) => {
      if (!isCurrentWs()) return;
      const message = JSON.parse(String(event.data)) as {
        type: string;
        peerId?: string;
        sdp?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
      };
      debug?.debug("signaling", message.type, message.peerId);
      switch (message.type) {
        case "offer":
          if (message.peerId === VOICE_AGENT_SERVER_PEER_ID && message.sdp) {
            enqueueServerOffer(message.sdp);
          }
          break;
        case "ice-candidate":
          if (
            message.peerId === VOICE_AGENT_SERVER_PEER_ID &&
            message.candidate &&
            !gracefulDisconnect
          ) {
            // Attribute to the latest negotiation generation (offer may already
            // be enqueued while PC is still null on the offerChain).
            const iceGeneration = negotiationGeneration;
            if (iceGeneration === 0) break;
            const targetPc = pc;
            if (
              targetPc &&
              activePcGeneration === iceGeneration &&
              pc === targetPc
            ) {
              if (!targetPc.remoteDescription) {
                queuePendingIce(iceGeneration, message.candidate);
              } else {
                void targetPc.addIceCandidate(message.candidate).catch(() => {
                  /* ignore stale/failed ICE on captured PC */
                });
              }
            } else {
              // PC not yet materialized for this generation — queue for drain.
              queuePendingIce(iceGeneration, message.candidate);
            }
          }
          break;
        default:
          break;
      }
    };

    localWs.onclose = (event?: WsCloseDetail) => {
      if (!isCurrentWs()) return;
      if (gracefulDisconnect || reconnectPolicy === "new-session") return;
      logSignalingFailure({
        phase: "open",
        url: signalingUrl,
        startedAtMs: Date.now(),
        close: event,
      });
      scheduleAutoReconnect("signaling_closed");
    };
  };

  const joinSignalingRoom = async (
    isReconnect: boolean,
    boundEpoch: number,
    deferOldPeerClose = false,
  ): Promise<void> => {
    if (isReconnect) {
      assertReplacementAllowed();
      // Close the old socket ourselves first; never wait for it to notice the outage.
      const staleWs = ws;
      if (staleWs) {
        staleWs.onclose = null;
        staleWs.onmessage = null;
        staleWs.onerror = null;
        try {
          staleWs.close();
        } catch {
          /* ignore */
        }
        if (ws === staleWs) {
          ws = null;
        }
      }
      const closeResult = await retirePeerConnection({
        preserveConnectedWait: true,
        deferClose: deferOldPeerClose,
      });
      emitDiagnosticSafely(options.onDiagnosticEvent, {
        type: "peer_close",
        status: closeResult.status,
        mode: closeResult.mode,
        durationMs: closeResult.durationMs,
        timedOut: closeResult.timedOut,
        context: "reconnect",
        ...(closeResult.error !== undefined
          ? { error: redactDiagnosticDetail(closeResult.error) }
          : {}),
      });
      if (closeResult.status !== "closed") {
        throw new Error(`reconnect blocked: peer close ${closeResult.status}`);
      }
      if (boundEpoch !== signalingEpoch) {
        return;
      }
      const previousWs = ws;
      if (previousWs) {
        previousWs.onclose = null;
        previousWs.onmessage = null;
        previousWs.onerror = null;
        try {
          previousWs.close();
        } catch {
          /* ignore */
        }
        if (ws === previousWs) {
          ws = null;
        }
      }
    }

    if (boundEpoch !== signalingEpoch) {
      return;
    }
    assertReplacementAllowed();

    const connectUrl = signalingUrl;
    const connectStartedAtMs = Date.now();
    const nextWs = new runtime.WebSocket(connectUrl);
    if (boundEpoch !== signalingEpoch) {
      try {
        nextWs.close();
      } catch {
        /* ignore */
      }
      return;
    }
    ws = nextWs;

    const httpStatusOf = (): number | undefined => {
      const status = (nextWs as unknown as { httpStatus?: unknown }).httpStatus;
      return typeof status === "number" ? status : undefined;
    };
    await new Promise<void>((resolve, reject) => {
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      /** `error` is followed by `close` (with code/reason) in the next task; wait for it briefly. */
      let errorTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = undefined;
        if (errorTimer) clearTimeout(errorTimer);
        errorTimer = undefined;
      };
      /** Connect-phase failure: log once, then reject (401 on reconnect = session gone). */
      const failConnect = (
        close: WsCloseDetail | undefined,
        error: Error,
      ): void => {
        if (done) return;
        done = true;
        settle();
        const httpStatus = httpStatusOf();
        logSignalingFailure({
          phase: "connect",
          url: connectUrl,
          startedAtMs: connectStartedAtMs,
          httpStatus,
          close,
        });
        reject(
          isReconnect && httpStatus === 401
            ? new SessionEndedDuringReconnectError()
            : error,
        );
      };
      if (isReconnect) {
        connectTimer = setTimeout(() => {
          connectTimer = undefined;
          if (ws !== nextWs || boundEpoch !== signalingEpoch) {
            reject(new Error("WebSocket superseded during reconnect"));
            return;
          }
          nextWs.onopen = null;
          nextWs.onerror = null;
          nextWs.onclose = null;
          try {
            nextWs.close();
          } catch {
            /* ignore */
          }
          failConnect(
            undefined,
            new Error(
              `WebSocket did not open within ${SIGNALING_CONNECT_TIMEOUT_MS}ms`,
            ),
          );
        }, SIGNALING_CONNECT_TIMEOUT_MS);
      }
      nextWs.onopen = () => {
        done = true;
        settle();
        if (ws !== nextWs || boundEpoch !== signalingEpoch) {
          reject(new Error("WebSocket superseded during reconnect"));
          return;
        }
        // sendSignal uses global ws — only send when this socket is current.
        sendSignal({ type: "join", room: roomId, peerId });
        debug?.info("signaling", "join_sent", `room=${roomId} peer=${peerId}`);
        debug?.info("signaling", isReconnect ? "rejoined" : "joined", roomId);
        updateConnectionSnapshot({ signalingJoined: true });
        if (isReconnect) reconnectJoinedWs = nextWs;
        resolve();
      };
      nextWs.onerror = () => {
        if (ws !== nextWs || boundEpoch !== signalingEpoch) {
          settle();
          reject(new Error("WebSocket superseded during reconnect"));
          return;
        }
        dispatchConnectionError(
          createConnectionError("WebSocket error", {
            subsystem: "webrtc",
            sessionId: orchestratorSessionId,
            peerId,
            kind: "signaling-ws",
          }),
          { fallbackLog: false },
        );
        errorTimer ??= setTimeout(() => {
          errorTimer = undefined;
          failConnect(undefined, new Error("WebSocket error"));
        }, 0);
      };
      // Close before open (with or without a preceding `error`) carries code/reason.
      nextWs.onclose = (event?: WsCloseDetail) => {
        if (ws !== nextWs || boundEpoch !== signalingEpoch) return;
        failConnect(event, new Error("WebSocket closed before open"));
      };
    });
    if (boundEpoch !== signalingEpoch) {
      if (ws === nextWs) {
        nextWs.onclose = null;
        nextWs.onmessage = null;
        try {
          nextWs.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
      return;
    }
    attachWsHandlers(nextWs, boundEpoch);
    if (isReconnect) {
      debug?.info("session", "same_session_reconnect", orchestratorSessionId);
    }
  };

  /** `recovery` (automatic) keeps the old PC open until the replacement connects. */
  const reconnectSignaling = (recovery = false): Promise<void> => {
    if (gracefulDisconnect) {
      return Promise.resolve();
    }
    if (replacementBlockedResult) {
      return Promise.reject(
        new Error(
          `reconnect blocked: previous close ${replacementBlockedResult.status}`,
        ),
      );
    }
    // True single-flight: all concurrent callers share one flight.
    if (reconnectFlight) {
      return reconnectFlight;
    }
    const epoch = ++signalingEpoch;
    const flight = joinSignalingRoom(true, epoch, recovery).finally(() => {
      if (reconnectFlight === flight) {
        reconnectFlight = null;
      }
    });
    reconnectFlight = flight;
    return flight;
  };

  const cleanupFailedInitialJoin = (): void => {
    const localWs = ws;
    ws = null;
    if (localWs) {
      localWs.onclose = null;
      localWs.onmessage = null;
      localWs.onerror = null;
      try {
        localWs.close();
      } catch {
        /* ignore */
      }
    }
    disposeCurrentMic();
    micRtpSender = null;
    updateConnectionSnapshot({
      signalingJoined: false,
      outboundAudioTrack: false,
    });
  };

  try {
    await joinSignalingRoom(false, signalingEpoch);
  } catch (error) {
    cleanupFailedInitialJoin();
    throw error;
  }
  publishConnectionStatus();

  // Do not log on every failed send — open/close transitions are already
  // emitted once via bindDataChannel (`dc/open`, `dc/close`). Callers (e.g. e2e
  // readiness polls) may probe often while connecting.
  const requireOpenControl = (): RTCDataChannel => {
    if (!controlChannel || controlChannel.readyState !== "open") {
      throw new Error("voice-control data channel is not open");
    }
    return controlChannel;
  };

  const requireOpenSync = (): RTCDataChannel => {
    if (!syncChannel || syncChannel.readyState !== "open") {
      throw new Error("voicethere-sync data channel is not open");
    }
    return syncChannel;
  };

  /**
   * Best-effort explicit hangup on the control channel. Only for integrator-initiated
   * ends, never for reconnects or unintentional loss.
   */
  const sendClientHangup = (): RTCDataChannel | null => {
    const channel = controlChannel;
    if (!channel || channel.readyState !== "open") return null;
    try {
      channel.send(JSON.stringify({ type: CLIENT_HANGUP_MESSAGE_TYPE }));
      debug?.info("session", "client_hangup_sent");
      return channel;
    } catch {
      return null;
    }
  };

  const waitForConnected = async (timeoutMs = 60_000): Promise<void> => {
    const deadlineMs = Date.now() + timeoutMs;
    const halfOpenFailFastMs = resolveHalfOpenFailFastMs(
      readinessProfile,
      timeoutMs,
    );
    let halfOpenSince: number | null = null;

    const syncHalfOpenClock = (): void => {
      if (!halfOpenFailFastMs) {
        halfOpenSince = null;
        return;
      }
      const status = buildWebRtcConnectionStatus(
        connectionSnapshot,
        readinessProfile,
      );
      if (isHalfOpenConnection(status)) {
        halfOpenSince ??= Date.now();
      } else {
        halfOpenSince = null;
      }
    };

    const throwConnectTimeout = (halfOpen: boolean): never => {
      const status = buildWebRtcConnectionStatus(
        connectionSnapshot,
        readinessProfile,
      );
      const halfOpenElapsedMs =
        halfOpen && halfOpenSince !== null
          ? Date.now() - halfOpenSince
          : undefined;
      const elapsedMs = halfOpen
        ? (halfOpenFailFastMs ?? timeoutMs)
        : timeoutMs;
      const error = new Error(
        formatWebRtcConnectTimeoutMessage(status, {
          elapsedMs,
          halfOpen,
          halfOpenElapsedMs,
        }),
      );
      notifySessionError({
        type: "session_error",
        code: "WEBRTC_CONNECT_TIMEOUT",
        message: error.message,
        session_id: orchestratorSessionId,
        recoverable: true,
        occurred_at: new Date().toISOString(),
      });
      throw error;
    };

    while (true) {
      syncHalfOpenClock();
      if (isWebRtcConnectionReady(connectionSnapshot, readinessProfile)) {
        clearConnectedWait();
        return;
      }
      if (pendingConnectFailure) {
        throw pendingConnectFailure;
      }
      if (gracefulDisconnect) {
        throw new Error("disconnected");
      }

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throwConnectTimeout(false);
      }

      if (halfOpenSince !== null && halfOpenFailFastMs !== null) {
        const halfOpenElapsedMs = Date.now() - halfOpenSince;
        if (halfOpenElapsedMs >= halfOpenFailFastMs) {
          throwConnectTimeout(true);
        }
      }

      const halfOpenRemainingMs =
        halfOpenSince !== null && halfOpenFailFastMs !== null
          ? halfOpenFailFastMs - (Date.now() - halfOpenSince)
          : Number.POSITIVE_INFINITY;
      const waitMs = Math.min(remainingMs, halfOpenRemainingMs);

      const waitPromise = ensureConnectedPromise();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          waitPromise,
          new Promise<void>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error("__wait_for_connected_timeout__"));
            }, waitMs);
          }),
        ]);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "__wait_for_connected_timeout__"
        ) {
          syncHalfOpenClock();
          if (
            halfOpenSince !== null &&
            halfOpenFailFastMs !== null &&
            Date.now() - halfOpenSince >= halfOpenFailFastMs
          ) {
            throwConnectTimeout(true);
          }
          throwConnectTimeout(false);
        }
        if (isWebRtcConnectRetryError(error)) {
          debug?.info(
            "session",
            "wait_for_connected_retry",
            `attempt=${autoReconnectAttempts}`,
          );
          continue;
        }
        throw error;
      } finally {
        // Success, retry, and disconnect paths must not leave a live timer.
        if (timer) clearTimeout(timer);
      }

      if (isWebRtcConnectionReady(connectionSnapshot, readinessProfile)) {
        clearConnectedWait();
        return;
      }
    }
  };

  return {
    peerId,
    getMicStream: () => micStream,
    listAudioInputDevices: () => listBrowserAudioInputDevices(),
    getAudioInputDeviceId: () => audioInputDeviceId,
    getAudioInputState: () => audioInputState,
    setAudioInputDevice: async (deviceId: string | null) => {
      await switchAudioInput(deviceId);
    },
    requestAudioInputAccess: async () =>
      switchAudioInput(audioInputDeviceId, { reRequest: true }),
    getAudioPlaybackState: () => audioPlaybackState,
    unlockAudioPlayback: async () => {
      if (!playbackAudioElement) return false;
      const ok = await unlockAudioPlaybackElement(playbackAudioElement);
      if (ok) {
        setAudioPlaybackState("playing");
      } else {
        debug?.warn("webrtc", "audio_playback_blocked");
        setAudioPlaybackState("blocked");
      }
      return ok;
    },
    getConnectionState: () => connectionState,
    getConnectionStatus: () =>
      buildWebRtcConnectionStatus(connectionSnapshot, readinessProfile),
    getWebRtcDiagnostics: async () =>
      collectWebRtcDiagnostics(
        pc,
        buildWebRtcConnectionStatus(connectionSnapshot, readinessProfile),
      ),
    waitForConnected,
    reconnect: async () => {
      autoReconnectAttempts = 0;
      iceRecoveryAttempts = 0;
      lastReconnectAttemptForCallback = 0;
      lastReconnectReason = "manual";
      awaitingReconnectedCallback = true;
      await reconnectSignaling();
    },
    forceCloseSignalingForTests: (): void => {
      if (gracefulDisconnect || reconnectPolicy === "new-session") return;
      const localWs = ws;
      if (!localWs) return;
      try {
        localWs.close();
      } catch {
        /* ignore */
      }
    },
    sendSpeak: (text: string) => {
      requireOpenControl().send(JSON.stringify({ type: "speak", text }));
      debug?.info("dc", "speak", text);
    },
    sendChat: (text: string) => {
      requireOpenControl().send(JSON.stringify({ type: "chat", text }));
      debug?.info("dc", "chat", text);
    },
    sendToAgent: (payload: Record<string, unknown>) => {
      requireOpenControl().send(JSON.stringify(payload));
      const payloadType = String(payload.type ?? "payload");
      if (HIGH_FREQUENCY_DC_TYPES.has(payloadType)) {
        debug?.debug("dc", "json", payloadType);
      } else {
        debug?.info("dc", "json", payloadType);
      }
    },
    sendBinary: (data: ArrayBuffer | Uint8Array) => {
      requireOpenControl().send(toArrayBuffer(data));
      debug?.debug("dc", "binary_send", `control:${data.byteLength}b`);
    },
    sendSyncBinary: (data: ArrayBuffer | Uint8Array) => {
      requireOpenSync().send(toArrayBuffer(data));
      debug?.debug("dc", "binary_send", `sync:${data.byteLength}b`);
    },
    sendCloseSignal: (reason?: string) => {
      gracefulDisconnect = true;
      requireOpenControl().send(
        JSON.stringify({
          type: "session_close",
          ...(reason ? { reason } : {}),
          ...(options.customerContext
            ? { customer_context: options.customerContext }
            : {}),
        }),
      );
      debug?.info("session", "close_signal", reason ?? "");
    },
    disconnect: () => {
      // Sync terminal invalidation — must not await native close (reconnect opens WS promptly).
      if (!gracefulDisconnect) sendClientHangup();
      gracefulDisconnect = true;
      closeDeferredOldPeerConnections();
      negotiationGeneration += 1;
      activePcGeneration = 0;
      clearPendingIceGenerations();
      // Invalidate in-flight reconnect WS handlers / epoch.
      signalingEpoch += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      clearRecoveryTimers();
      awaitingReconnectedCallback = false;
      stopMicPump?.();
      stopMicPump = null;
      rejectConnected?.(new Error("disconnected"));
      clearConnectedWait();
      pendingConnectFailure = null;

      const asyncOwnsPeerClose = disconnectAsyncInFlight !== null;
      const localControl = controlChannel;
      const localSync = syncChannel;
      const localPc = asyncOwnsPeerClose ? null : pc;
      const localWs = ws;
      controlChannel = null;
      syncChannel = null;
      if (!asyncOwnsPeerClose) {
        pc = null;
      }
      ws = null;
      disposeCurrentMic();
      disposeOwnedAudioElement();
      micRtpSender = null;
      try {
        localControl?.close();
      } catch {
        /* ignore */
      }
      try {
        localSync?.close();
      } catch {
        /* ignore */
      }
      if (localWs) {
        localWs.onclose = null;
        localWs.onmessage = null;
        localWs.onerror = null;
        try {
          localWs.close();
        } catch {
          /* ignore */
        }
      }
      // Do not sync-close while disconnectAsync owns native close — that masks
      // timed_out/failed outcomes from soak callers awaiting the async barrier.
      // Also do not sync-close a quarantined PC (native close already timed out).
      if (localPc && localPc !== quarantinedPc) {
        intentionallyRetiringPcs.add(localPc);
        try {
          localPc.close();
        } catch {
          /* ignore */
        }
      }
      // If sync disconnect wins on an async-capable runtime, record an explicit
      // sync terminal outcome — later disconnectAsync must not claim async close.
      // Prefer retained replacement-blocked failure over inventing closed.
      if (!asyncOwnsPeerClose && !terminalDisconnectResult) {
        terminalDisconnectResult = replacementBlockedResult ?? {
          status: "closed",
          mode: "sync",
          durationMs: 0,
          timedOut: false,
        };
      }
      updateConnectionSnapshot({
        signalingJoined: false,
        peerConnectionState: "closed",
        inboundAudioTrack: false,
        outboundAudioTrack: false,
        controlChannelOpen: false,
        syncChannelOpen: false,
      });
      debug?.info("session", "disconnected");
    },
    disconnectAsync: async () => {
      if (terminalDisconnectResult) {
        return terminalDisconnectResult;
      }
      if (replacementBlockedResult) {
        // Unsafe old PC already retired/quarantined — surface that strict failure.
        terminalDisconnectResult = replacementBlockedResult;
        return replacementBlockedResult;
      }
      if (disconnectAsyncInFlight) {
        return disconnectAsyncInFlight;
      }

      disconnectAsyncInFlight = (async (): Promise<PeerCloseResult> => {
        const hangupChannel = gracefulDisconnect ? null : sendClientHangup();
        if (hangupChannel) {
          const drainDeadline = Date.now() + CLIENT_HANGUP_DRAIN_MS;
          while (
            hangupChannel.readyState === "open" &&
            (hangupChannel.bufferedAmount ?? 0) > 0 &&
            Date.now() < drainDeadline
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
        }
        gracefulDisconnect = true;
        closeDeferredOldPeerConnections();
        negotiationGeneration += 1;
        activePcGeneration = 0;
        clearPendingIceGenerations();
        signalingEpoch += 1;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        clearRecoveryTimers();
        awaitingReconnectedCallback = false;
        stopMicPump?.();
        stopMicPump = null;
        rejectConnected?.(new Error("disconnected"));
        clearConnectedWait();
        pendingConnectFailure = null;

        const localControl = controlChannel;
        const localSync = syncChannel;
        const localPc = pc;
        const localWs = ws;
        controlChannel = null;
        syncChannel = null;
        pc = null;
        ws = null;
        disposeCurrentMic();
        disposeOwnedAudioElement();
        micRtpSender = null;

        try {
          localControl?.close();
        } catch {
          /* ignore */
        }
        try {
          localSync?.close();
        } catch {
          /* ignore */
        }
        if (localWs) {
          localWs.onclose = null;
          localWs.onmessage = null;
          localWs.onerror = null;
          try {
            localWs.close();
          } catch {
            /* ignore */
          }
        }

        // Never retry native close on a quarantined PC after timed_out/failed.
        const closeTarget =
          localPc && localPc !== quarantinedPc ? localPc : null;
        if (closeTarget) {
          intentionallyRetiringPcs.add(closeTarget);
        }
        const closeResult = closeTarget
          ? await closePeerConnectionAwaitable(closeTarget)
          : (replacementBlockedResult ?? {
              status: "closed" as const,
              mode: "sync" as const,
              durationMs: 0,
              timedOut: false,
            });
        terminalDisconnectResult = closeResult;
        emitDiagnosticSafely(options.onDiagnosticEvent, {
          type: "peer_close",
          status: closeResult.status,
          mode: closeResult.mode,
          durationMs: closeResult.durationMs,
          timedOut: closeResult.timedOut,
          context: "disconnect",
          ...(closeResult.error !== undefined
            ? { error: redactDiagnosticDetail(closeResult.error) }
            : {}),
        });

        updateConnectionSnapshot({
          signalingJoined: false,
          peerConnectionState: "closed",
          inboundAudioTrack: false,
          outboundAudioTrack: false,
          controlChannelOpen: false,
          syncChannelOpen: false,
        });
        debug?.info(
          "session",
          "disconnected",
          `peer_close=${closeResult.status}`,
        );
        return closeResult;
      })();

      try {
        return await disconnectAsyncInFlight;
      } finally {
        disconnectAsyncInFlight = null;
      }
    },
  };
}
