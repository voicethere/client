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
   * Max automatic same-session retries after unintentional signaling/WebRTC loss
   * (default 4). `waitForConnected()` keeps waiting through these ICE reconnect
   * attempts until `timeoutMs` elapses. Set `0` to fail on the first transport error.
   */
  maxAutoReconnectAttempts?: number;
  onReconnecting?: (attempt: number) => void;
  /**
   * Readiness gate for `waitForConnected()` / `getConnectionStatus().ready`.
   * Defaults from `requestMic`: voice sessions wait for inbound+outbound audio tracks;
   * data sessions wait for voice-control and voicethere-sync channels to open.
   */
  readiness?: WebRtcReadinessProfile;
  /** Fired whenever WebRTC connection readiness changes (signaling through media/DCs). */
  onConnectionStatus?: (status: WebRtcConnectionStatus) => void;
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
): Promise<void> {
  for (const track of micStream.getAudioTracks()) {
    const result = pc.addTrack(track as MediaStreamTrack, micStream) as
      RTCRtpSender | Promise<RTCRtpSender> | void;
    if (
      result &&
      typeof (result as Promise<RTCRtpSender>).then === "function"
    ) {
      await result;
    }
  }
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
  const signalingUrl = appendJoinToken(
    options.credentials.signaling_url,
    options.credentials.join_token,
  );
  const iceServers = options.credentials.ice_servers?.length
    ? options.credentials.ice_servers
    : [{ urls: "stun:stun.l.google.com:19302" }];

  let ws: WebSocket | null = null;
  let pc: RTCPeerConnection | null = null;
  let controlChannel: RTCDataChannel | null = null;
  let syncChannel: RTCDataChannel | null = null;
  let micStream: MediaStream | null = null;
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
  const maxAutoReconnectAttempts = options.maxAutoReconnectAttempts ?? 4;
  let autoReconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const readinessProfile = resolveReadinessProfile({
    requestMic: options.requestMic,
    readiness: options.readiness,
  });

  const connectionSnapshot: WebRtcConnectionSnapshot = {
    signalingJoined: false,
    peerConnectionState: "new",
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
    updateConnectionSnapshot({
      outboundAudioTrack: micStream
        .getAudioTracks()
        .some((track) => track.readyState === "live"),
    });
  };

  const tryResolveConnected = (): void => {
    if (!isWebRtcConnectionReady(connectionSnapshot, readinessProfile)) return;
    pendingConnectFailure = null;
    resolveConnected?.();
    // Success path must drop waiter handles immediately (not only timeout/reject).
    clearConnectedWait();
  };

  const updateConnectionSnapshot = (
    patch: Partial<WebRtcConnectionSnapshot>,
  ): void => {
    Object.assign(connectionSnapshot, patch);
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
    options.onControlMessage?.(message);
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
    return autoReconnectAttempts < maxAutoReconnectAttempts;
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
    if (!gracefulDisconnect) {
      if (state === "failed") {
        notifySessionError({
          type: "session_error",
          code: "WEBRTC_CONNECTION_FAILED",
          message: "WebRTC peer connection failed",
          session_id: orchestratorSessionId,
          recoverable: canAutoReconnectTransport(),
          occurred_at: new Date().toISOString(),
        });
      } else {
        notifySessionError({
          type: "session_error",
          code: "WEBRTC_CONNECTION_CLOSED",
          message: "WebRTC peer connection closed unexpectedly",
          session_id: orchestratorSessionId,
          recoverable: canAutoReconnectTransport(),
          occurred_at: new Date().toISOString(),
        });
      }
    }

    const retriable = canAutoReconnectTransport();
    rejectConnectedWait(new Error(`peer connection ${state}`), retriable);
    if (retriable) {
      scheduleAutoReconnect(reconnectReason);
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
        message.type !== "agent_error"
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
    const getUserMedia = runtime.getUserMedia;
    if (!getUserMedia) {
      throw new Error(
        "runtime.getUserMedia is required when requestMic is true",
      );
    }
    micStream = await getUserMedia({
      audio: true,
      video: false,
    });
    syncOutboundAudioTrack();
    debug?.info("voice", "mic_granted");
  }

  /**
   * Retire the current PC with the awaitable close barrier.
   * Callers that will create a replacement must abort when status is not `closed`.
   * On timed_out/failed, quarantine and block all future replacements.
   */
  const retirePeerConnection = async (retireOptions?: {
    preserveConnectedWait?: boolean;
  }): Promise<PeerCloseResult> => {
    if (replacementBlockedResult) {
      return replacementBlockedResult;
    }
    stopMicPump?.();
    stopMicPump = null;
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
    // Detach from live slot before awaiting close so handlers see identity change.
    pc = null;
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
        ...(options.iceTransportPolicy
          ? { iceTransportPolicy: options.iceTransportPolicy }
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
        if (options.audioElement) {
          options.audioElement.srcObject = stream;
          void options.audioElement.play().catch(() => undefined);
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
          sendToServer({
            type: "ice-candidate",
            targetPeerId: VOICE_AGENT_SERVER_PEER_ID,
            candidate: event.candidate.toJSON(),
          });
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
          autoReconnectAttempts = 0;
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
        debug?.info(
          "webrtc",
          "ice_connection_state",
          localPc.iceConnectionState ?? "unknown",
        );
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
        await attachMicTracks(localPc, micStream);
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

      // Send the answer immediately — do NOT wait for ICE gathering.
      // Waiting races TURN CreatePermission on the runner: Chrome starts
      // connectivity checks right after setLocalDescription, but the runner only
      // learns our srflx/relay (and installs TURN permissions) after the answer
      // + trickle candidates arrive. Hosting many host/IPv6/TURN gathers can
      // delay gathering-complete past Chrome's ICE failure (~15–20s) → every
      // pair shows STUN sent / 0 responses (relay↔relay included). Trickle
      // `onicecandidate` already ships candidates; the runner queues them until
      // setRemoteDescription(answer).
      step = "send_answer";
      sendToServer({
        type: "answer",
        targetPeerId: VOICE_AGENT_SERVER_PEER_ID,
        sdp: localPc.localDescription,
      });
      debug?.info("signaling", "answer_sent");
      logOfferStep(step);

      // Best-effort: surface gather completion in debug logs (non-blocking).
      void waitForIceGatheringComplete(localPc)
        .then(() => {
          if (!isOfferCurrent() || !isPcCurrent()) return;
          debug?.info("webrtc", "ice_gathering_complete");
          logOfferStep("wait_ice_gathering");
        })
        .catch((error: unknown) => {
          if (!isOfferCurrent() || !isPcCurrent()) return;
          const detail = error instanceof Error ? error.message : String(error);
          debug?.warn("webrtc", "ice_gathering_wait_failed", detail);
        });
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
    if (autoReconnectAttempts >= maxAutoReconnectAttempts) {
      debug?.warn("session", "auto_reconnect_exhausted", reason);
      return;
    }
    autoReconnectAttempts += 1;
    options.onReconnecting?.(autoReconnectAttempts);
    const delayMs = Math.min(1000 * 2 ** (autoReconnectAttempts - 1), 8000);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      void reconnectSignaling().catch((error: unknown) => {
        debug?.warn(
          "session",
          "auto_reconnect_failed",
          error instanceof Error ? error.message : String(error),
        );
        scheduleAutoReconnect(reason);
      });
    }, delayMs);
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

    localWs.onclose = () => {
      if (!isCurrentWs()) return;
      if (gracefulDisconnect || reconnectPolicy === "new-session") return;
      scheduleAutoReconnect("signaling_closed");
    };
  };

  const joinSignalingRoom = async (
    isReconnect: boolean,
    boundEpoch: number,
  ): Promise<void> => {
    if (isReconnect) {
      assertReplacementAllowed();
      const closeResult = await retirePeerConnection({
        preserveConnectedWait: true,
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

    const nextWs = new runtime.WebSocket(signalingUrl);
    if (boundEpoch !== signalingEpoch) {
      try {
        nextWs.close();
      } catch {
        /* ignore */
      }
      return;
    }
    ws = nextWs;

    await new Promise<void>((resolve, reject) => {
      nextWs.onopen = () => {
        if (ws !== nextWs || boundEpoch !== signalingEpoch) {
          reject(new Error("WebSocket superseded during reconnect"));
          return;
        }
        // sendSignal uses global ws — only send when this socket is current.
        sendSignal({ type: "join", room: roomId, peerId });
        debug?.info("signaling", "join_sent", `room=${roomId} peer=${peerId}`);
        debug?.info("signaling", isReconnect ? "rejoined" : "joined", roomId);
        updateConnectionSnapshot({ signalingJoined: true });
        resolve();
      };
      nextWs.onerror = () => {
        if (ws !== nextWs || boundEpoch !== signalingEpoch) {
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
        debug?.error(
          "signaling",
          "ws_error",
          redactSignalingUrlForLog(signalingUrl),
        );
        reject(new Error("WebSocket error"));
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

  const reconnectSignaling = (): Promise<void> => {
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
    const flight = joinSignalingRoom(true, epoch).finally(() => {
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
    const localMic = micStream;
    micStream = null;
    localMic?.getTracks().forEach((track) => track.stop());
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
      if (status.peerConnectionState === "connected" && !status.ready) {
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
      await reconnectSignaling();
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
      gracefulDisconnect = true;
      negotiationGeneration += 1;
      activePcGeneration = 0;
      clearPendingIceGenerations();
      // Invalidate in-flight reconnect WS handlers / epoch.
      signalingEpoch += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
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
      const localMic = micStream;
      controlChannel = null;
      syncChannel = null;
      if (!asyncOwnsPeerClose) {
        pc = null;
      }
      ws = null;
      micStream = null;
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
      localMic?.getTracks().forEach((track) => track.stop());
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
        gracefulDisconnect = true;
        negotiationGeneration += 1;
        activePcGeneration = 0;
        clearPendingIceGenerations();
        signalingEpoch += 1;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        stopMicPump?.();
        stopMicPump = null;
        rejectConnected?.(new Error("disconnected"));
        clearConnectedWait();
        pendingConnectFailure = null;

        const localControl = controlChannel;
        const localSync = syncChannel;
        const localPc = pc;
        const localWs = ws;
        const localMic = micStream;
        controlChannel = null;
        syncChannel = null;
        pc = null;
        ws = null;
        micStream = null;

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
        localMic?.getTracks().forEach((track) => track.stop());

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
