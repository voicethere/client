export type WebRtcReadinessProfile = "voice" | "data" | "voice_and_data";

/** Post-ICE stuck budget for voice / voice+data (capped by overall connect timeout). */
export const DEFAULT_HALF_OPEN_FAIL_FAST_MS = 20_000;

export type WebRtcConnectionPhase =
  | "signaling"
  | "negotiating"
  | "connecting"
  | "awaiting_media"
  | "awaiting_channels"
  | "ready"
  | "failed"
  | "closed";

/** Default message shown while the transport is down and the client retries. */
export const CONNECTION_INTERRUPTED_MESSAGE = "Connection lost. Reconnecting…";
/** Default message shown once the transport is back. */
export const CONNECTION_RESTORED_MESSAGE = "Reconnected.";
/** Default message shown when the reconnect budget is spent. */
export const CONNECTION_LOST_MESSAGE =
  "The connection could not be restored. Please start a new conversation.";
/** Default message shown when the server reports the session is gone during a reconnect. */
export const CONNECTION_SESSION_ENDED_MESSAGE =
  "The conversation ended while the connection was down. Please start a new one.";

/** Latest transport-recovery event; carried on {@link WebRtcConnectionStatus.recovery}. */
export type ConnectionRecoveryStatus =
  | {
      state: "interrupted";
      /** Milliseconds since the transport was first lost. */
      sinceMs: number;
      message: string;
    }
  | {
      state: "restored";
      /** Total time the transport was down. */
      downtimeMs: number;
      via: "ice-restart" | "reconnect";
      message: string;
    }
  | {
      state: "lost";
      /** Session error code, e.g. `WEBRTC_RECONNECT_EXHAUSTED` or `SESSION_ENDED_DURING_RECONNECT`. */
      reason: string;
      message: string;
    };

export type WebRtcConnectionSnapshot = {
  signalingJoined: boolean;
  peerConnectionState: RTCPeerConnectionState | "new";
  /** Present when the runtime exposes RTCPeerConnection.iceConnectionState. */
  iceConnectionState?: RTCIceConnectionState | "new";
  inboundAudioTrack: boolean;
  outboundAudioTrack: boolean;
  controlChannelOpen: boolean;
  syncChannelOpen: boolean;
  /** Set once a transport outage starts after the session was ready. */
  recovery?: ConnectionRecoveryStatus;
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

  const needsMedia = profile === "voice" || profile === "voice_and_data";
  const needsChannels = profile === "data" || profile === "voice_and_data";

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
  const phase = ready
    ? "ready"
    : deriveWebRtcConnectionPhase(snapshot, profile);
  return { ...snapshot, phase, ready };
}

export function usesHalfOpenFailFast(profile: WebRtcReadinessProfile): boolean {
  return profile === "voice" || profile === "voice_and_data";
}

function iceTransportConnected(
  iceConnectionState: WebRtcConnectionSnapshot["iceConnectionState"],
): boolean {
  return (
    iceConnectionState === "connected" || iceConnectionState === "completed"
  );
}

/** ICE up but session readiness (media/channels) not satisfied — half-open fail-fast arms. */
export function isHalfOpenConnection(status: WebRtcConnectionStatus): boolean {
  if (status.ready) return false;
  if (status.peerConnectionState === "connected") return true;
  return (
    iceTransportConnected(status.iceConnectionState) &&
    status.peerConnectionState === "connecting"
  );
}

export function resolveHalfOpenFailFastMs(
  profile: WebRtcReadinessProfile,
  overallTimeoutMs: number,
): number | null {
  if (!usesHalfOpenFailFast(profile)) return null;
  return Math.min(DEFAULT_HALF_OPEN_FAIL_FAST_MS, overallTimeoutMs);
}

export function formatWebRtcConnectTimeoutMessage(
  status: WebRtcConnectionStatus,
  options: {
    elapsedMs: number;
    halfOpen: boolean;
    halfOpenElapsedMs?: number;
  },
): string {
  const parts = [
    options.halfOpen
      ? `WebRTC half-open timeout after ${options.elapsedMs}ms`
      : `WebRTC connect timeout after ${options.elapsedMs}ms`,
    `half_open=${options.halfOpen ? "true" : "false"}`,
    `phase=${status.phase}`,
    `pc=${status.peerConnectionState}`,
    ...(status.iceConnectionState !== undefined
      ? [`ice=${status.iceConnectionState}`]
      : []),
    `signalingJoined=${status.signalingJoined}`,
    `control=${status.controlChannelOpen}`,
    `sync=${status.syncChannelOpen}`,
  ];
  if (options.halfOpenElapsedMs !== undefined) {
    parts.push(`half_open_elapsed_ms=${options.halfOpenElapsedMs}`);
  }
  return parts.join("; ");
}
