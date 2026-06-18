import {
  LocalAudioTrack,
  MediaStream,
  RTCPeerConnection,
} from "@node-webrtc-rust/sdk";

import type { WebRtcRuntime } from "../browser/webrtc-runtime.js";
import { NodeWebSocketAdapter } from "./node-websocket.js";

/**
 * Node.js WebRTC runtime for headless E2E tests (uses @node-webrtc-rust/sdk + ws).
 */
export function createNodeWebRtcRuntime(): WebRtcRuntime {
  return {
    WebSocket: NodeWebSocketAdapter as unknown as WebRtcRuntime["WebSocket"],
    RTCPeerConnection:
      RTCPeerConnection as unknown as WebRtcRuntime["RTCPeerConnection"],
    getUserMedia: async (_constraints) => {
      const track = new LocalAudioTrack("mic", "mic-stream");
      const stream = new MediaStream([track]);
      return stream as unknown as globalThis.MediaStream;
    },
  };
}
