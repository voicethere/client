import type { SessionCredentials } from "./session-provision.js";
import type { DebugConsole } from "./debug-console.js";
import {
  connectBrowserVoiceSession,
  type BrowserVoiceSession,
} from "./browser-voice-session.js";

export const VOICETHERE_CHAT_CHANNEL_LABEL = "voicethere";

export type BrowserChatSessionOptions = {
  credentials: SessionCredentials;
  peerId?: string;
  onDebugEvent?: DebugConsole;
};

/**
 * DC-only session — connects WebRTC without microphone for text chat debugging.
 */
export async function connectBrowserChatSession(
  options: BrowserChatSessionOptions,
): Promise<BrowserVoiceSession> {
  return connectBrowserVoiceSession({
    ...options,
    requestMic: false,
  });
}
