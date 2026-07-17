import {
  createConnectionError,
  dispatchConnectionError,
} from "../connection-errors.js";

import { appendJoinToken } from "../resolve-connection.js";
import {
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
  isWebRtcConnectionReady,
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
import { waitForIceGatheringComplete } from "./wait-for-ice-gathering.js";
import {
  isWebRtcConnectRetryError,
  WebRtcConnectRetryError,
} from "./webrtc-connect-retry.js";

/** Game-sync DC traffic logged at debug level — E2E stderr needs `LOAD_TEST_CLIENT_DEBUG=1`. */
const HIGH_FREQUENCY_DC_TYPES = new Set(["keepalive", "state", "tick"]);

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
  disconnect: () => void;
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
  const pendingIce: RTCIceCandidateInit[] = [];
  let connectionState: RTCPeerConnectionState | "new" = "new";
  let resolveConnected: (() => void) | null = null;
  let rejectConnected: ((error: Error) => void) | null = null;
  let connectedPromise: Promise<void> | null = null;
  let stopMicPump: (() => void) | null = null;
  let gracefulDisconnect = false;
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
    resolveConnected?.();
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
    rejectConnected?.(
      retriable ? new WebRtcConnectRetryError(error.message) : error,
    );
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
  ) => {
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event) => {
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

  let ignorePeerConnectionClose = false;

  const resetPeerConnection = (options?: {
    preserveConnectedWait?: boolean;
  }): void => {
    stopMicPump?.();
    stopMicPump = null;
    controlChannel = null;
    syncChannel = null;
    if (pc) {
      ignorePeerConnectionClose = true;
      pc.close();
      ignorePeerConnectionClose = false;
    }
    pc = null;
    pendingIce.length = 0;
    connectionState = "new";
    if (!options?.preserveConnectedWait) {
      connectedPromise = null;
      resolveConnected = null;
      rejectConnected = null;
    }
    updateConnectionSnapshot({
      peerConnectionState: "new",
      inboundAudioTrack: false,
      outboundAudioTrack: false,
      controlChannelOpen: false,
      syncChannelOpen: false,
    });
  };

  const bindDataChannel = (
    channel: RTCDataChannel,
    binding: {
      kind: DataChannelKind;
      label: string;
      openField: "controlChannelOpen" | "syncChannelOpen";
      assign: (next: RTCDataChannel | null) => void;
      onOpen?: (channel: RTCDataChannel) => void;
    },
  ): void => {
    binding.assign(channel);

    const markOpen = () => {
      updateConnectionSnapshot({ [binding.openField]: true });
    };

    channel.onopen = () => {
      debug?.info("dc", "open", binding.label);
      markOpen();
      binding.onOpen?.(channel);
    };
    if (channel.readyState === "open") markOpen();

    channel.onclose = () => {
      debug?.info("dc", "close", binding.label);
      binding.assign(null);
      updateConnectionSnapshot({ [binding.openField]: false });
    };

    wireBinaryChannel(channel, binding.kind);
  };

  const wireControl = (channel: RTCDataChannel) => {
    bindDataChannel(channel, {
      kind: "control",
      label: VOICE_CONTROL_CHANNEL_LABEL,
      openField: "controlChannelOpen",
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
    });
  };

  const wireSync = (channel: RTCDataChannel) => {
    bindDataChannel(channel, {
      kind: "sync",
      label: VOICE_SYNC_CHANNEL_LABEL,
      openField: "syncChannelOpen",
      assign: (next) => {
        syncChannel = next;
      },
    });
  };

  const onServerOffer = async (sdp: RTCSessionDescriptionInit) => {
    if (pc) {
      ignorePeerConnectionClose = true;
      pc.close();
      ignorePeerConnectionClose = false;
      pc = null;
      pendingIce.length = 0;
      controlChannel = null;
      syncChannel = null;
      connectionState = "new";
      updateConnectionSnapshot({
        peerConnectionState: "new",
        inboundAudioTrack: false,
        outboundAudioTrack: false,
        controlChannelOpen: false,
        syncChannelOpen: false,
      });
    }

    ensureConnectedPromise();
    pc = new runtime.RTCPeerConnection({ iceServers });

    pc.ontrack = (event) => {
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

    pc.ondatachannel = (event) => {
      if (event.channel.label === VOICE_CONTROL_CHANNEL_LABEL) {
        wireControl(event.channel);
      } else if (event.channel.label === VOICE_SYNC_CHANNEL_LABEL) {
        wireSync(event.channel);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendToServer({
          type: "ice-candidate",
          targetPeerId: VOICE_AGENT_SERVER_PEER_ID,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      connectionState = pc?.connectionState ?? "new";
      debug?.info("webrtc", "connection_state", connectionState);
      updateConnectionSnapshot({ peerConnectionState: connectionState });
      if (connectionState === "connected") {
        autoReconnectAttempts = 0;
        stopMicPump?.();
        stopMicPump = null;
        if (micStream && (options.micPump ?? "silent") === "silent") {
          stopMicPump = createMicPump(
            micStream,
            () => pc?.connectionState === "connected",
            debug,
          );
        }
        syncOutboundAudioTrack();
      } else if (connectionState === "failed") {
        handleTransportFailure("failed", "webrtc_failed");
      } else if (connectionState === "closed") {
        if (ignorePeerConnectionClose || gracefulDisconnect) {
          if (gracefulDisconnect) {
            rejectConnectedWait(
              new Error(`peer connection ${connectionState}`),
              false,
            );
          }
          return;
        }
        handleTransportFailure("closed", "webrtc_closed");
      }
    };

    pc.oniceconnectionstatechange = () => {
      debug?.info(
        "webrtc",
        "ice_connection_state",
        pc?.iceConnectionState ?? "unknown",
      );
    };

    pc.onicegatheringstatechange = () => {
      debug?.info(
        "webrtc",
        "ice_gathering_state",
        pc?.iceGatheringState ?? "unknown",
      );
    };

    if (micStream) {
      await attachMicTracks(pc, micStream);
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
    }

    await pc.setRemoteDescription(sdp);
    for (const candidate of pendingIce.splice(0)) {
      await pc.addIceCandidate(candidate);
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);
    sendToServer({
      type: "answer",
      targetPeerId: VOICE_AGENT_SERVER_PEER_ID,
      sdp: pc.localDescription,
    });
    debug?.info("signaling", "answer_sent");
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

  const attachWsMessageHandler = (): void => {
    if (!ws) return;
    ws.onmessage = (event) => {
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
            void onServerOffer(message.sdp);
          }
          break;
        case "ice-candidate":
          if (
            message.peerId === VOICE_AGENT_SERVER_PEER_ID &&
            message.candidate &&
            pc
          ) {
            if (!pc.remoteDescription) {
              pendingIce.push(message.candidate);
            } else {
              void pc.addIceCandidate(message.candidate);
            }
          }
          break;
        default:
          break;
      }
    };
  };

  const joinSignalingRoom = async (isReconnect: boolean): Promise<void> => {
    if (isReconnect) {
      resetPeerConnection({ preserveConnectedWait: true });
      if (ws) {
        ws.onclose = null;
        ws.close();
        ws = null;
      }
    }
    ws = new runtime.WebSocket(signalingUrl);
    await new Promise<void>((resolve, reject) => {
      if (!ws) return reject(new Error("WebSocket missing"));
      ws.onopen = () => {
        sendSignal({ type: "join", room: roomId, peerId });
        debug?.info("signaling", "join_sent", `room=${roomId} peer=${peerId}`);
        debug?.info("signaling", isReconnect ? "rejoined" : "joined", roomId);
        updateConnectionSnapshot({ signalingJoined: true });
        resolve();
      };
      ws.onerror = () => {
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
    attachWsMessageHandler();
    ws.onclose = () => {
      if (gracefulDisconnect || reconnectPolicy === "new-session") return;
      scheduleAutoReconnect("signaling_closed");
    };
    if (isReconnect) {
      debug?.info("session", "same_session_reconnect", orchestratorSessionId);
    }
  };

  const reconnectSignaling = async (): Promise<void> => {
    await joinSignalingRoom(true);
  };

  await joinSignalingRoom(false);
  publishConnectionStatus();

  const requireOpenControl = (): RTCDataChannel => {
    if (!controlChannel || controlChannel.readyState !== "open") {
      debug?.error("dc", "control_not_open");
      throw new Error("voice-control data channel is not open");
    }
    return controlChannel;
  };

  const requireOpenSync = (): RTCDataChannel => {
    if (!syncChannel || syncChannel.readyState !== "open") {
      debug?.error("dc", "sync_not_open");
      throw new Error("voicethere-sync data channel is not open");
    }
    return syncChannel;
  };

  const waitForConnected = async (timeoutMs = 60_000): Promise<void> => {
    const deadlineMs = Date.now() + timeoutMs;

    const throwConnectTimeout = (): never => {
      const status = buildWebRtcConnectionStatus(
        connectionSnapshot,
        readinessProfile,
      );
      const elapsedMs = timeoutMs;
      const error = new Error(
        `WebRTC connect timeout after ${elapsedMs}ms; phase=${status.phase}; pc=${status.peerConnectionState}; signalingJoined=${status.signalingJoined}; control=${status.controlChannelOpen}; sync=${status.syncChannelOpen}`,
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
      if (isWebRtcConnectionReady(connectionSnapshot, readinessProfile)) return;

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throwConnectTimeout();
      }

      const waitPromise = ensureConnectedPromise();
      try {
        await Promise.race([
          waitPromise,
          new Promise<void>((_, reject) => {
            setTimeout(() => {
              reject(new Error("__wait_for_connected_timeout__"));
            }, remainingMs);
          }),
        ]);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "__wait_for_connected_timeout__"
        ) {
          throwConnectTimeout();
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
      }

      if (isWebRtcConnectionReady(connectionSnapshot, readinessProfile)) return;
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
      gracefulDisconnect = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopMicPump?.();
      stopMicPump = null;
      controlChannel?.close();
      syncChannel?.close();
      pc?.close();
      micStream?.getTracks().forEach((track) => track.stop());
      ws?.close();
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
  };
}
