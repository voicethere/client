import { describe, expect, it, vi } from "vitest";

const { connectBrowserVoiceSession } = vi.hoisted(() => ({
  connectBrowserVoiceSession: vi.fn(),
}));

vi.mock("./browser-voice-session.js", () => ({
  connectBrowserVoiceSession,
}));

import { connectBrowserSession } from "./browser-session.js";

describe("connectBrowserSession", () => {
  it("forwards onAgentAudioTrack, onBinaryMessage, and onSyncBinaryMessage callbacks", async () => {
    const baseSession = {
      peerId: "client-test",
      disconnect: vi.fn(),
      sendCloseSignal: vi.fn(),
      sendSpeak: vi.fn(),
      sendChat: vi.fn(),
      sendToAgent: vi.fn(),
      sendBinary: vi.fn(),
      sendSyncBinary: vi.fn(),
      getMicStream: () => null,
      waitForConnected: vi.fn(async () => undefined),
      getConnectionState: () => "new" as const,
      reconnect: vi.fn(async () => undefined),
    };
    connectBrowserVoiceSession.mockResolvedValue(baseSession);

    const onControlMessage = vi.fn();
    const onBinaryMessage = vi.fn();
    const onSyncBinaryMessage = vi.fn();
    const onAgentAudioTrack = vi.fn();

    const session = await connectBrowserSession({
      mode: "voice",
      credentials: {
        session_id: "s",
        mode: "voice",
        room_id: "r",
        join_token: "j",
        signaling_url: "ws://127.0.0.1:8080/ws",
        ice_servers: [],
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      onControlMessage,
      onBinaryMessage,
      onSyncBinaryMessage,
      onAgentAudioTrack,
    });

    expect(connectBrowserVoiceSession).toHaveBeenCalledWith(
      expect.objectContaining({
        requestMic: true,
        onControlMessage,
        onBinaryMessage,
        onSyncBinaryMessage,
        onAgentAudioTrack,
      }),
    );
    expect(session.mode).toBe("voice");
  });

  it("defaults to server-provided mode when mode is omitted", async () => {
    const baseSession = {
      peerId: "client-test",
      disconnect: vi.fn(),
      sendCloseSignal: vi.fn(),
      sendSpeak: vi.fn(),
      sendChat: vi.fn(),
      sendToAgent: vi.fn(),
      sendBinary: vi.fn(),
      sendSyncBinary: vi.fn(),
      getMicStream: () => null,
      waitForConnected: vi.fn(async () => undefined),
      getConnectionState: () => "new" as const,
      reconnect: vi.fn(async () => undefined),
    };
    connectBrowserVoiceSession.mockResolvedValue(baseSession);

    const session = await connectBrowserSession({
      credentials: {
        session_id: "s",
        mode: "data",
        room_id: "r",
        join_token: "j",
        signaling_url: "ws://127.0.0.1:8080/ws",
        ice_servers: [],
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    expect(connectBrowserVoiceSession).toHaveBeenCalledWith(
      expect.objectContaining({ requestMic: false }),
    );
    expect(session.mode).toBe("chat");
  });
});
