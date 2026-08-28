import type { DebugConsole } from "./debug-console.js";
import type { SessionCredentials } from "./session-provision.js";
import { connectBrowserChatSession } from "./browser-chat-session.js";
import {
  connectBrowserVoiceSession,
  type BrowserVoiceSession,
  type BrowserVoiceSessionOptions,
} from "./browser-voice-session.js";
import {
  BrowserSessionModeType,
  ProvisionedRunnerModeType,
  type BrowserSessionMode,
} from "./session-modes.js";
import type {
  WebRtcConnectionStatus,
  WebRtcReadinessProfile,
} from "./webrtc-connection-status.js";

export type ConnectBrowserSessionOptions = {
  mode?: BrowserSessionMode;
  credentials: SessionCredentials;
  peerId?: string;
  audioElement?: HTMLAudioElement;
  onDebugEvent?: DebugConsole;
  customerContext?: Record<string, unknown>;
  onSessionError?: import("../session-errors.js").SessionErrorHandler;
  onControlMessage?: (payload: Record<string, unknown>) => void;
  onBinaryMessage?: BrowserVoiceSessionOptions["onBinaryMessage"];
  onSyncBinaryMessage?: BrowserVoiceSessionOptions["onSyncBinaryMessage"];
  onAgentAudioTrack?: BrowserVoiceSessionOptions["onAgentAudioTrack"];
  reconnectPolicy?: import("./browser-voice-session.js").ReconnectPolicy;
  maxAutoReconnectAttempts?: number;
  maxIceRecoveryAttempts?: number;
  onIceRecovery?: import("./browser-voice-session.js").BrowserVoiceSessionOptions["onIceRecovery"];
  onReconnecting?: import("./browser-voice-session.js").BrowserVoiceSessionOptions["onReconnecting"];
  onReconnected?: import("./browser-voice-session.js").BrowserVoiceSessionOptions["onReconnected"];
  onConnectionStatus?: (status: WebRtcConnectionStatus) => void;
  iceTransportPolicy?: BrowserVoiceSessionOptions["iceTransportPolicy"];
  onDiagnosticEvent?: BrowserVoiceSessionOptions["onDiagnosticEvent"];
  /** Preferred audio input device for voice / voice+data sessions. */
  audioInputDeviceId?: string;
  /** Fired when inbound agent audio playback starts or is blocked by the browser. */
  onAudioPlayback?: BrowserVoiceSessionOptions["onAudioPlayback"];
};

export type BrowserSession = BrowserVoiceSession & {
  mode: BrowserSessionMode;
};

export async function connectBrowserSession(
  options: ConnectBrowserSessionOptions,
): Promise<BrowserSession> {
  const serverMode: BrowserSessionMode =
    options.credentials.mode === ProvisionedRunnerModeType.Data
      ? BrowserSessionModeType.Chat
      : options.credentials.mode;
  const resolvedMode = options.mode ?? serverMode;
  if (
    serverMode === BrowserSessionModeType.Chat &&
    resolvedMode !== BrowserSessionModeType.Chat
  ) {
    throw new Error("Session mode mismatch: server provisioned data mode");
  }
  if (
    serverMode === BrowserSessionModeType.Voice &&
    resolvedMode !== BrowserSessionModeType.Voice
  ) {
    throw new Error("Session mode mismatch: server provisioned voice mode");
  }
  const requestMic =
    resolvedMode === BrowserSessionModeType.Voice ||
    resolvedMode === BrowserSessionModeType.VoiceAndData;
  const readiness: WebRtcReadinessProfile =
    resolvedMode === BrowserSessionModeType.VoiceAndData
      ? "voice_and_data"
      : resolvedMode === BrowserSessionModeType.Voice
        ? "voice"
        : "data";
  const session = await connectBrowserVoiceSession({
    credentials: options.credentials,
    peerId: options.peerId,
    requestMic,
    readiness,
    audioElement: options.audioElement,
    onDebugEvent: options.onDebugEvent,
    customerContext: options.customerContext,
    onSessionError: options.onSessionError,
    onControlMessage: options.onControlMessage,
    onBinaryMessage: options.onBinaryMessage,
    onSyncBinaryMessage: options.onSyncBinaryMessage,
    onAgentAudioTrack: options.onAgentAudioTrack,
    reconnectPolicy: options.reconnectPolicy,
    maxAutoReconnectAttempts: options.maxAutoReconnectAttempts,
    maxIceRecoveryAttempts: options.maxIceRecoveryAttempts,
    onIceRecovery: options.onIceRecovery,
    onReconnecting: options.onReconnecting,
    onReconnected: options.onReconnected,
    onConnectionStatus: options.onConnectionStatus,
    iceTransportPolicy: options.iceTransportPolicy,
    onDiagnosticEvent: options.onDiagnosticEvent,
    audioInputDeviceId: requestMic ? options.audioInputDeviceId : undefined,
    onAudioPlayback: options.onAudioPlayback,
  });

  return { ...session, mode: resolvedMode };
}

export async function connectDataSession(
  options: Omit<BrowserVoiceSessionOptions, "requestMic">,
): Promise<BrowserVoiceSession> {
  return connectBrowserVoiceSession({ ...options, requestMic: false });
}

export type {
  ReconnectPolicy,
  VoiceSessionReconnectInfo,
} from "./browser-voice-session.js";
export { connectBrowserChatSession } from "./browser-chat-session.js";
export {
  connectBrowserVoiceSession,
  VOICE_SYNC_CHANNEL_LABEL,
  VOICE_CONTROL_CHANNEL_LABEL,
  type BinaryMessageHandler,
  type SyncBinaryMessageHandler,
  type DataChannelKind,
  type BrowserVoiceSession,
  type BrowserVoiceSessionOptions,
} from "./browser-voice-session.js";
export { startSession } from "./session-provision.js";
export {
  DEFAULT_SESSION_API_RETRY_DELAYS_MS,
  fetchSessionApi,
  isRetryableSessionApiBody,
  isRetryableSessionApiFailure,
  isRetryableSessionApiNetworkError,
  isRetryableSessionApiStatus,
  type FetchSessionApiOptions,
  type SessionApiRetryRuntime,
} from "./session-api-retry.js";
export {
  createLocalSessionError,
  emitSessionError,
  isSessionErrorEvent,
  LOCAL_SESSION_ERROR_CODES,
  REMOTE_SESSION_ERROR_CODES,
  SESSION_ERROR_CODES,
  type SessionErrorCode,
  type SessionErrorEvent,
  type SessionErrorHandler,
} from "../session-errors.js";
export {
  ConnectionError,
  createConnectionError,
  formatConnectionErrorSource,
  getRootConnectionErrorHandler,
  reportConnectionError,
  setRootConnectionErrorHandler,
  type ConnectionErrorSource,
  type RootConnectionErrorHandler,
} from "../connection-errors.js";
export { attachAudioVisualizer } from "./audio-visualizer.js";
export { createDebugConsole } from "./debug-console.js";

export type {
  SessionCredentials,
  SessionStatusResponse,
  StartSessionOptions,
  StartSessionResult,
} from "./session-provision.js";
export {
  BrowserSessionModeType,
  ProvisionedRunnerModeType,
  type BrowserSessionMode,
  type ProvisionedRunnerMode,
} from "./session-modes.js";
export type {
  WebRtcConnectionPhase,
  WebRtcConnectionSnapshot,
  WebRtcConnectionStatus,
  WebRtcReadinessProfile,
} from "./webrtc-connection-status.js";
export {
  buildWebRtcConnectionStatus,
  deriveWebRtcConnectionPhase,
  isWebRtcConnectionReady,
  resolveReadinessProfile,
} from "./webrtc-connection-status.js";
export {
  collectWebRtcDiagnostics,
  formatIceTriageLine,
  formatWebRtcDiagnosticsLines,
  summarizeRtcStatsReport,
  type IceTriageExtra,
  type WebRtcDiagnostics,
  type WebRtcIceCandidatePairSummary,
  type WebRtcStatsSummary,
} from "./webrtc-diagnostics.js";

export type { DebugConsole, DebugEvent } from "./debug-console.js";
export type { WebRtcRuntime } from "./webrtc-runtime.js";
export {
  getDefaultBrowserRuntime,
  peerConnectionSupportsCloseAsync,
} from "./webrtc-runtime.js";
export {
  closePeerConnectionAwaitable,
  type AwaitableCloseablePeerConnection,
  type PeerCloseResult,
  type PeerCloseStatus,
} from "./peer-connection-close.js";
export type {
  VoiceSessionDiagnosticEvent,
  VoiceSessionDiagnosticHandler,
} from "./voice-session-diagnostics.js";
export { redactDiagnosticDetail } from "./voice-session-diagnostics.js";
export {
  CLIENT_CAPABILITIES,
  type ClientCapabilities,
} from "./client-capabilities.js";
export {
  acquireAudioInput,
  createSyntheticMicStream,
  listAudioInputDevices,
  stopMicStream,
  type AudioInputDevice,
  type AudioInputState,
} from "./microphone.js";
export {
  createHiddenAudioElement,
  unlockAudioPlayback,
  type AudioPlaybackState,
} from "./audio-playback.js";
