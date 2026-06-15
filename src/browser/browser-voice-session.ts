import { appendJoinToken } from "../resolve-connection.js";
import type { SessionCredentials } from "./session-provision.js";
import type { DebugConsole } from "./debug-console.js";

export const VOICE_AGENT_SERVER_PEER_ID = "voice-agent-server";
export const VOICE_CONTROL_CHANNEL_LABEL = "voice-control";

export type BrowserVoiceSessionOptions = {
  credentials: SessionCredentials;
  peerId?: string;
  requestMic?: boolean;
  audioElement?: HTMLAudioElement;
  onDebugEvent?: DebugConsole;
};

export type BrowserVoiceSession = {
  peerId: string;
  disconnect: () => void;
  sendSpeak: (text: string) => void;
  sendChat: (text: string) => void;
  getMicStream: () => MediaStream | null;
};

function defaultPeerId(): string {
  return `client-${Math.random().toString(36).slice(2, 10)}`;
}

export async function connectBrowserVoiceSession(
  options: BrowserVoiceSessionOptions,
): Promise<BrowserVoiceSession> {
  const debug = options.onDebugEvent;
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
  let micStream: MediaStream | null = null;
  const pendingIce: RTCIceCandidateInit[] = [];

  const sendSignal = (message: Record<string, unknown>) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const sendToServer = (payload: Record<string, unknown>) => {
    sendSignal({ room: roomId, peerId, ...payload });
  };

  if (options.requestMic !== false) {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    debug?.info("voice", "mic_granted");
  }

  ws = new WebSocket(signalingUrl);

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
    channel.onmessage = (event) => {
      debug?.debug("dc", "message", String(event.data));
      try {
        const message = JSON.parse(String(event.data)) as {
          type?: string;
          event?: string;
          text?: string;
        };
        if (message.type === "speech_event") {
          debug?.info("speech", message.event ?? "event", message.text);
        } else {
          debug?.info("dc", message.type ?? "json", message.text);
        }
      } catch {
        debug?.warn("dc", "malformed", String(event.data));
      }
    };
  };

  const onServerOffer = async (sdp: RTCSessionDescriptionInit) => {
    if (pc) {
      pc.close();
      pc = null;
      pendingIce.length = 0;
    }

    pc = new RTCPeerConnection({ iceServers });

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
      debug?.info("webrtc", "connection_state", pc?.connectionState);
    };

    await pc.setRemoteDescription(sdp);
    for (const candidate of pendingIce.splice(0)) {
      await pc.addIceCandidate(candidate);
    }

    if (micStream) {
      for (const track of micStream.getAudioTracks()) {
        pc.addTrack(track, micStream);
      }
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

  return {
    peerId,
    getMicStream: () => micStream,
    sendSpeak: (text: string) => {
      if (!controlChannel || controlChannel.readyState !== "open") {
        debug?.error("dc", "speak_failed", "control channel not open");
        return;
      }
      controlChannel.send(JSON.stringify({ type: "speak", text }));
      debug?.info("dc", "speak", text);
    },
    sendChat: (text: string) => {
      if (!controlChannel || controlChannel.readyState !== "open") {
        debug?.error("dc", "chat_failed", "control channel not open");
        return;
      }
      controlChannel.send(JSON.stringify({ type: "chat", text }));
      debug?.info("dc", "chat", text);
    },
    disconnect: () => {
      controlChannel?.close();
      pc?.close();
      micStream?.getTracks().forEach((track) => track.stop());
      ws?.close();
      debug?.info("session", "disconnected");
    },
  };
}
