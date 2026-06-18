import { appendJoinToken } from "../resolve-connection.js";
import type { SessionCredentials } from "./session-provision.js";
import type { DebugConsole } from "./debug-console.js";
import {
  getDefaultBrowserRuntime,
  type WebRtcRuntime,
} from "./webrtc-runtime.js";

export const VOICE_AGENT_SERVER_PEER_ID = "voice-agent-server";
export const VOICE_CONTROL_CHANNEL_LABEL = "voice-control";
/** High-frequency binary sync channel (matches `@node-webrtc-rust/sdk/voice`). */
export const VOICE_SYNC_CHANNEL_LABEL = "voicethere-sync";

export type DataChannelKind = "control" | "sync";

export type BinaryMessageHandler = (
  data: ArrayBuffer,
  channel: DataChannelKind,
) => void;

export type BrowserVoiceSessionOptions = {
  credentials: SessionCredentials;
  peerId?: string;
  requestMic?: boolean;
  audioElement?: HTMLAudioElement;
  onDebugEvent?: DebugConsole;
  /** Injectable WebRTC runtime (default: browser globals). */
  runtime?: WebRtcRuntime;
  /** Fired for JSON messages on voice-control (e.g. speech_event). */
  onControlMessage?: (payload: Record<string, unknown>) => void;
  /** Fired for binary frames on voice-control or voicethere-sync. */
  onBinaryMessage?: BinaryMessageHandler;
};

export type BrowserVoiceSession = {
  peerId: string;
  disconnect: () => void;
  sendSpeak: (text: string) => void;
  sendChat: (text: string) => void;
  /** JSON on voice-control (same as sendChat for `{ type: 'chat' }`). */
  sendToAgent: (payload: Record<string, unknown>) => void;
  /** Binary on voice-control data channel. */
  sendBinary: (data: ArrayBuffer | Uint8Array) => void;
  /** Binary on voicethere-sync data channel (throws if channel not open). */
  sendSyncBinary: (data: ArrayBuffer | Uint8Array) => void;
  getMicStream: () => MediaStream | null;
  /** Resolves when peer connection reaches `connected` (or rejects on timeout/failure). */
  waitForConnected: (timeoutMs?: number) => Promise<void>;
  getConnectionState: () => RTCPeerConnectionState | "new";
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
    const result = pc.addTrack(
      track as MediaStreamTrack,
      micStream,
    ) as RTCRtpSender | Promise<RTCRtpSender> | void;
    if (result && typeof (result as Promise<RTCRtpSender>).then === "function") {
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

  const ensureConnectedPromise = (): Promise<void> => {
    if (!connectedPromise) {
      connectedPromise = new Promise<void>((resolve, reject) => {
        resolveConnected = resolve;
        rejectConnected = reject;
      });
    }
    return connectedPromise;
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
    options.onBinaryMessage?.(data, channel);
  };

  const handleControlJson = (raw: string) => {
    debug?.debug("dc", "message", raw);
    try {
      const message = JSON.parse(raw) as Record<string, unknown> & {
        type?: string;
        event?: string;
        text?: string;
      };
      options.onControlMessage?.(message);
      if (message.type === "speech_event") {
        debug?.info("speech", message.event ?? "event", message.text);
      } else {
        debug?.info("dc", message.type ?? "json", message.text);
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
                new Uint8Array(
                  view.buffer,
                  view.byteOffset,
                  view.byteLength,
                ),
              );
              return copy;
            })();
      dispatchBinary(buf, kind);
    };
  };

  if (options.requestMic !== false) {
    const getUserMedia = runtime.getUserMedia;
    if (!getUserMedia) {
      throw new Error("runtime.getUserMedia is required when requestMic is true");
    }
    micStream = await getUserMedia({
      audio: true,
      video: false,
    });
    debug?.info("voice", "mic_granted");
  }

  ws = new runtime.WebSocket(signalingUrl);

  await new Promise<void>((resolve, reject) => {
    if (!ws) return reject(new Error("WebSocket missing"));
    ws.onopen = () => {
      sendSignal({ type: "join", room: roomId, peerId });
      debug?.info("signaling", "joined", roomId);
      resolve();
    };
    ws.onerror = () => reject(new Error("WebSocket error"));
  });

  const wireControl = (channel: RTCDataChannel) => {
    controlChannel = channel;
    channel.onopen = () =>
      debug?.info("dc", "open", VOICE_CONTROL_CHANNEL_LABEL);
    channel.onclose = () => {
      debug?.info("dc", "close", VOICE_CONTROL_CHANNEL_LABEL);
      controlChannel = null;
    };
    wireBinaryChannel(channel, "control");
  };

  const wireSync = (channel: RTCDataChannel) => {
    syncChannel = channel;
    channel.onopen = () =>
      debug?.info("dc", "open", VOICE_SYNC_CHANNEL_LABEL);
    channel.onclose = () => {
      debug?.info("dc", "close", VOICE_SYNC_CHANNEL_LABEL);
      syncChannel = null;
    };
    wireBinaryChannel(channel, "sync");
  };

  const onServerOffer = async (sdp: RTCSessionDescriptionInit) => {
    if (pc) {
      pc.close();
      pc = null;
      pendingIce.length = 0;
      controlChannel = null;
      syncChannel = null;
      connectionState = "new";
      connectedPromise = null;
      resolveConnected = null;
      rejectConnected = null;
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
      if (connectionState === "connected") {
        stopMicPump?.();
        stopMicPump = createMicPump(
          micStream,
          () => pc?.connectionState === "connected",
          debug,
        );
        resolveConnected?.();
      } else if (
        connectionState === "failed" ||
        connectionState === "closed"
      ) {
        stopMicPump?.();
        stopMicPump = null;
        rejectConnected?.(
          new Error(`peer connection ${connectionState}`),
        );
      }
    };

    if (micStream) {
      await attachMicTracks(pc, micStream);
    }

    await pc.setRemoteDescription(sdp);
    for (const candidate of pendingIce.splice(0)) {
      await pc.addIceCandidate(candidate);
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendToServer({
      type: "answer",
      targetPeerId: VOICE_AGENT_SERVER_PEER_ID,
      sdp: pc.localDescription,
    });
    debug?.info("signaling", "answer_sent");
  };

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
    if (connectionState === "connected") return;
    ensureConnectedPromise();
    await Promise.race([
      connectedPromise,
      new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error(`WebRTC connect timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  };

  return {
    peerId,
    getMicStream: () => micStream,
    getConnectionState: () => connectionState,
    waitForConnected,
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
      debug?.info("dc", "json", String(payload.type ?? "payload"));
    },
    sendBinary: (data: ArrayBuffer | Uint8Array) => {
      requireOpenControl().send(toArrayBuffer(data));
      debug?.debug("dc", "binary_send", `control:${data.byteLength}b`);
    },
    sendSyncBinary: (data: ArrayBuffer | Uint8Array) => {
      requireOpenSync().send(toArrayBuffer(data));
      debug?.debug("dc", "binary_send", `sync:${data.byteLength}b`);
    },
    disconnect: () => {
      stopMicPump?.();
      stopMicPump = null;
      controlChannel?.close();
      syncChannel?.close();
      pc?.close();
      micStream?.getTracks().forEach((track) => track.stop());
      ws?.close();
      debug?.info("session", "disconnected");
    },
  };
}
