/**
 * Injectable WebRTC + signaling primitives for browser and Node test runtimes.
 */
export type WebRtcRuntime = {
  WebSocket: {
    new (url: string, protocols?: string | string[]): WebSocket;
    readonly OPEN: number;
  };
  RTCPeerConnection: {
    new (configuration?: RTCConfiguration): RTCPeerConnection;
  };
  getUserMedia?: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
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
