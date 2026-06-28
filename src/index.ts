import { SignalingClient } from "@node-webrtc-rust/signaling";

import { resolveConnection } from "./resolve-connection.js";
import type { ConnectedClient, VoiceThereClientOptions } from "./types.js";

/**
 * Connect to VoiceThere signaling — local runner (plain ws) or cloud gateway (JWT).
 * Returns a thin wrapper around {@link SignalingClient} for WebRTC negotiation.
 */
export async function connectVoiceSession(
  options: VoiceThereClientOptions,
): Promise<ConnectedClient> {
  const { signalingUrl, roomId, peerId } = resolveConnection(options);
  const client = new SignalingClient({
    url: signalingUrl,
    room: roomId,
    peerId,
  });

  await client.connect();

  return {
    peerId: client.peerId,
    roomId: client.room,
    signalingUrl,
    disconnect: () => client.disconnect(),
    on: (event, listener) => {
      client.on(event, listener);
    },
  };
}

export { appendJoinToken, resolveConnection } from "./resolve-connection.js";
export {
  ConnectionError,
  createConnectionError,
  formatConnectionErrorSource,
  getRootConnectionErrorHandler,
  reportConnectionError,
  setRootConnectionErrorHandler,
  type ConnectionErrorSource,
  type RootConnectionErrorHandler,
} from "./connection-errors.js";
export type {
  CloudSessionCredentials,
  VoiceThereClientOptions,
  ConnectedClient,
} from "./types.js";
