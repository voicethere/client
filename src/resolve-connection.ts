import type { CloudSessionCredentials, VoiceThereClientOptions } from "./types.js";

export function appendJoinToken(signalingUrl: string, joinToken: string): string {
  const url = new URL(signalingUrl);
  if (!url.searchParams.has("token")) {
    url.searchParams.set("token", joinToken);
  }
  return url.toString();
}

export function resolveConnection(options: VoiceThereClientOptions): {
  signalingUrl: string;
  roomId: string;
  peerId?: string;
} {
  if (options.mode === "local") {
    return {
      signalingUrl: options.signalingUrl,
      roomId: options.sessionId,
      peerId: options.peerId,
    };
  }

  const creds = options.credentials;
  return {
    signalingUrl: appendJoinToken(creds.signalingUrl, creds.joinToken),
    roomId: creds.roomId,
    peerId: options.peerId,
  };
}

export type { CloudSessionCredentials };
