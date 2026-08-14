/**
 * Injectable WebRTC + signaling primitives for browser and Node test runtimes.
 */

import type { AwaitableCloseablePeerConnection } from "./peer-connection-close.js";

export type { AwaitableCloseablePeerConnection };

export type WebRtcRuntime = {
  WebSocket: {
    new (url: string, protocols?: string | string[]): WebSocket;
    readonly OPEN: number;
  };
  RTCPeerConnection: {
    new (configuration?: RTCConfiguration): RTCPeerConnection;
  };
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /**
   * How to send the SDP answer after setLocalDescription.
   * - `trickle-immediate` (default / browser): send immediately; trickle via onicecandidate.
   *   Chrome starts ICE checks right away; waiting for gathering-complete can lose the ~15–20s race.
   * - `wait-gathering` (Node runtime): wait until local ICE candidates are in localDescription,
   *   then send. node-webrtc-rust gathering is fast; production relay-only runners need
   *   a=candidate in the answer because trickle is not sufficient on this path.
   */
  iceAnswerPolicy?: "wait-gathering" | "trickle-immediate";
};

export function getDefaultBrowserRuntime(): WebRtcRuntime {
  if (typeof globalThis.WebSocket === "undefined") {
    throw new Error(
      "WebSocket is not available; pass runtime (e.g. createNodeWebRtcRuntime from @voicethere/client/node)",
    );
  }
  if (typeof globalThis.RTCPeerConnection === "undefined") {
    throw new Error(
      "RTCPeerConnection is not available; pass runtime from @voicethere/client/node",
    );
  }

  return {
    WebSocket: globalThis.WebSocket,
    RTCPeerConnection: globalThis.RTCPeerConnection,
    getUserMedia: async (constraints) => {
      if (!navigator?.mediaDevices?.getUserMedia) {
        throw new Error("navigator.mediaDevices.getUserMedia is not available");
      }
      return navigator.mediaDevices.getUserMedia(constraints);
    },
  };
}

/** True when a peer connection instance exposes awaitable native cleanup. */
export function peerConnectionSupportsCloseAsync(
  pc: RTCPeerConnection | null | undefined,
): boolean {
  return (
    typeof (pc as AwaitableCloseablePeerConnection | null | undefined)
      ?.closeAsync === "function"
  );
}
