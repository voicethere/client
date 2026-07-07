export type WebRtcReadinessProfile = "voice" | "data" | "voice_and_data";

export type WebRtcConnectionPhase =
  | "signaling"
  | "negotiating"
  | "connecting"
  | "awaiting_media"
  | "awaiting_channels"
  | "ready"
  | "failed"
  | "closed";

export type WebRtcConnectionSnapshot = {
  signalingJoined: boolean;
  peerConnectionState: RTCPeerConnectionState | "new";
  inboundAudioTrack: boolean;
  outboundAudioTrack: boolean;
  controlChannelOpen: boolean;
  syncChannelOpen: boolean;
};

export type WebRtcConnectionStatus = WebRtcConnectionSnapshot & {
  phase: WebRtcConnectionPhase;
  ready: boolean;
};

export function resolveReadinessProfile(input: {
  requestMic?: boolean;
  readiness?: WebRtcReadinessProfile;
}): WebRtcReadinessProfile {
  if (input.readiness) return input.readiness;
  return input.requestMic !== false ? "voice" : "data";
}

function voiceMediaReady(snapshot: WebRtcConnectionSnapshot): boolean {
  return snapshot.inboundAudioTrack && snapshot.outboundAudioTrack;
}

function dataChannelsReady(snapshot: WebRtcConnectionSnapshot): boolean {
  return snapshot.controlChannelOpen && snapshot.syncChannelOpen;
}

export function isWebRtcConnectionReady(
  snapshot: WebRtcConnectionSnapshot,
  profile: WebRtcReadinessProfile,
): boolean {
  if (snapshot.peerConnectionState !== "connected") return false;
  if (profile === "voice") return voiceMediaReady(snapshot);
  if (profile === "data") return dataChannelsReady(snapshot);
  return voiceMediaReady(snapshot) && dataChannelsReady(snapshot);
}

export function deriveWebRtcConnectionPhase(
  snapshot: WebRtcConnectionSnapshot,
  profile: WebRtcReadinessProfile,
): WebRtcConnectionPhase {
  if (snapshot.peerConnectionState === "failed") return "failed";
  if (snapshot.peerConnectionState === "closed") return "closed";

  if (!snapshot.signalingJoined) return "signaling";
  if (snapshot.peerConnectionState === "new") return "negotiating";
  if (
    snapshot.peerConnectionState === "connecting" ||
    snapshot.peerConnectionState === "disconnected"
  ) {
    return "connecting";
  }

  if (snapshot.peerConnectionState !== "connected") return "connecting";

  const needsMedia =
    profile === "voice" || profile === "voice_and_data";
  const needsChannels =
    profile === "data" || profile === "voice_and_data";

  if (needsMedia && !voiceMediaReady(snapshot)) return "awaiting_media";
  if (needsChannels && !dataChannelsReady(snapshot)) {
    return "awaiting_channels";
  }

  return "ready";
}

export function buildWebRtcConnectionStatus(
  snapshot: WebRtcConnectionSnapshot,
  profile: WebRtcReadinessProfile,
): WebRtcConnectionStatus {
  const ready = isWebRtcConnectionReady(snapshot, profile);
  const phase = ready ? "ready" : deriveWebRtcConnectionPhase(snapshot, profile);
  return { ...snapshot, phase, ready };
}
