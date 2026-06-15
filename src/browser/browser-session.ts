import type { DebugConsole } from "./debug-console.js";
import type { SessionCredentials } from "./session-provision.js";
import { connectBrowserChatSession } from "./browser-chat-session.js";
import {
  connectBrowserVoiceSession,
  type BrowserVoiceSession,
} from "./browser-voice-session.js";

export type BrowserSessionMode = "voice" | "chat" | "both";

export type ConnectBrowserSessionOptions = {
  mode: BrowserSessionMode;
  credentials: SessionCredentials;
  peerId?: string;
  audioElement?: HTMLAudioElement;
  onDebugEvent?: DebugConsole;
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
  });

  return { ...session, mode: options.mode };
}

export { connectBrowserChatSession } from "./browser-chat-session.js";
export { connectBrowserVoiceSession } from "./browser-voice-session.js";
export { startSession } from "./session-provision.js";
export { attachAudioVisualizer } from "./audio-visualizer.js";
export { createDebugConsole } from "./debug-console.js";

export type {
  SessionCredentials,
  SessionStatusResponse,
  StartSessionOptions,
  StartSessionResult,
} from "./session-provision.js";

export type { DebugConsole, DebugEvent } from "./debug-console.js";
