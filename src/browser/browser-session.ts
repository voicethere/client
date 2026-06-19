import type { DebugConsole } from "./debug-console.js";
import type { SessionCredentials } from "./session-provision.js";
import { connectBrowserChatSession } from "./browser-chat-session.js";
import {
  connectBrowserVoiceSession,
  type BrowserVoiceSession,
  type BrowserVoiceSessionOptions,
} from "./browser-voice-session.js";

export type BrowserSessionMode = "voice" | "chat" | "both";

export type ConnectBrowserSessionOptions = {
  mode: BrowserSessionMode;
  credentials: SessionCredentials;
  peerId?: string;
  audioElement?: HTMLAudioElement;
  onDebugEvent?: DebugConsole;
  customerContext?: Record<string, unknown>;
  onSessionError?: import("../session-errors.js").SessionErrorHandler;
  onControlMessage?: (payload: Record<string, unknown>) => void;
  reconnectPolicy?: import("./browser-voice-session.js").ReconnectPolicy;
  maxAutoReconnectAttempts?: number;
  onReconnecting?: (attempt: number) => void;
};

export type BrowserSession = BrowserVoiceSession & {
  mode: BrowserSessionMode;
};

export async function connectBrowserSession(
  options: ConnectBrowserSessionOptions,
): Promise<BrowserSession> {
  const requestMic = options.mode === "voice" || options.mode === "both";
  const session = await connectBrowserVoiceSession({
    credentials: options.credentials,
    peerId: options.peerId,
    requestMic,
    audioElement: options.audioElement,
    onDebugEvent: options.onDebugEvent,
    customerContext: options.customerContext,
    onSessionError: options.onSessionError,
    onControlMessage: options.onControlMessage,
    reconnectPolicy: options.reconnectPolicy,
    maxAutoReconnectAttempts: options.maxAutoReconnectAttempts,
    onReconnecting: options.onReconnecting,
  });

  return { ...session, mode: options.mode };
}

export async function connectDataSession(
  options: Omit<BrowserVoiceSessionOptions, "requestMic">,
): Promise<BrowserVoiceSession> {
  return connectBrowserVoiceSession({ ...options, requestMic: false });
}

export type { ReconnectPolicy } from "./browser-voice-session.js";
export { connectBrowserChatSession } from "./browser-chat-session.js";
export {
  connectBrowserVoiceSession,
  VOICE_SYNC_CHANNEL_LABEL,
  VOICE_CONTROL_CHANNEL_LABEL,
  type BinaryMessageHandler,
  type DataChannelKind,
  type BrowserVoiceSession,
  type BrowserVoiceSessionOptions,
} from "./browser-voice-session.js";
export { startSession } from "./session-provision.js";
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
export { attachAudioVisualizer } from "./audio-visualizer.js";
export { createDebugConsole } from "./debug-console.js";

export type {
  SessionCredentials,
  SessionStatusResponse,
  StartSessionOptions,
  StartSessionResult,
} from "./session-provision.js";

export type { DebugConsole, DebugEvent } from "./debug-console.js";
export type { WebRtcRuntime } from "./webrtc-runtime.js";
export { getDefaultBrowserRuntime } from "./webrtc-runtime.js";
