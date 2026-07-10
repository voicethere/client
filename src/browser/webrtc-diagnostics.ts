import type { WebRtcConnectionStatus } from "./webrtc-connection-status.js";

export type WebRtcStatsSummary = {
  totalReports: number;
  candidatePairs: number;
  nominatedPairs: number;
  succeededPairs: number;
  failedPairs: number;
  relayLocalCandidates: number;
  hostLocalCandidates: number;
  srflxLocalCandidates: number;
  selectedPairId?: string;
  selectedLocalType?: string;
  selectedRemoteType?: string;
  selectedProtocol?: string;
};

export type WebRtcDiagnostics = {
  peerConnectionState: RTCPeerConnectionState | "new";
  iceConnectionState: RTCIceConnectionState | "unknown";
  iceGatheringState: RTCIceGatheringState | "unknown";
  signalingState: RTCSignalingState | "unknown";
  connectionStatus: WebRtcConnectionStatus;
  stats: WebRtcStatsSummary;
};

function readString(
  report: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = report[key];
  return typeof value === "string" ? value : undefined;
}

function readBool(report: Record<string, unknown>, key: string): boolean {
  return report[key] === true;
}

/** Summarize {@link RTCPeerConnection.getStats} for logs (candidate pairs, relay usage). */
export function summarizeRtcStatsReport(
  stats: RTCStatsReport,
): WebRtcStatsSummary {
  const locals = new Map<string, Record<string, unknown>>();
  let candidatePairs = 0;
  let nominatedPairs = 0;
  let succeededPairs = 0;
  let failedPairs = 0;
  let relayLocalCandidates = 0;
  let hostLocalCandidates = 0;
  let srflxLocalCandidates = 0;
  let selectedPairId: string | undefined;
  let selectedLocalType: string | undefined;
  let selectedRemoteType: string | undefined;
  let selectedProtocol: string | undefined;

  stats.forEach((report, id) => {
    const row = report as Record<string, unknown>;
    const type = readString(row, "type");
    if (type === "local-candidate") {
      locals.set(id, row);
      const candidateType = readString(row, "candidateType");
      if (candidateType === "relay") relayLocalCandidates += 1;
      if (candidateType === "host") hostLocalCandidates += 1;
      if (candidateType === "srflx") srflxLocalCandidates += 1;
      return;
    }
    if (type !== "candidate-pair") return;

    candidatePairs += 1;
    if (readBool(row, "nominated")) nominatedPairs += 1;
    const state = readString(row, "state");
    if (state === "succeeded") succeededPairs += 1;
    if (state === "failed") failedPairs += 1;

    if (readBool(row, "selected") || readBool(row, "nominated")) {
      selectedPairId = id;
      selectedProtocol = readString(row, "protocol");
      const localId = readString(row, "localCandidateId");
      const remoteId = readString(row, "remoteCandidateId");
      if (localId && locals.has(localId)) {
        selectedLocalType = readString(locals.get(localId)!, "candidateType");
      }
      if (remoteId) {
        const remote = stats.get(remoteId) as
          Record<string, unknown> | undefined;
        if (remote) {
          selectedRemoteType = readString(remote, "candidateType");
        }
      }
    }
  });

  return {
    totalReports: stats.size,
    candidatePairs,
    nominatedPairs,
    succeededPairs,
    failedPairs,
    relayLocalCandidates,
    hostLocalCandidates,
    srflxLocalCandidates,
    selectedPairId,
    selectedLocalType,
    selectedRemoteType,
    selectedProtocol,
  };
}

export async function collectWebRtcDiagnostics(
  pc: RTCPeerConnection | null,
  connectionStatus: WebRtcConnectionStatus,
): Promise<WebRtcDiagnostics | null> {
  if (!pc) return null;

  let stats: WebRtcStatsSummary = {
    totalReports: 0,
    candidatePairs: 0,
    nominatedPairs: 0,
    succeededPairs: 0,
    failedPairs: 0,
    relayLocalCandidates: 0,
    hostLocalCandidates: 0,
    srflxLocalCandidates: 0,
  };

  try {
    stats = summarizeRtcStatsReport(await pc.getStats());
  } catch {
    // getStats may fail after close — keep ICE state fields below.
  }

  return {
    peerConnectionState: pc.connectionState ?? "new",
    iceConnectionState: pc.iceConnectionState ?? "unknown",
    iceGatheringState: pc.iceGatheringState ?? "unknown",
    signalingState: pc.signalingState ?? "unknown",
    connectionStatus,
    stats,
  };
}

export function formatWebRtcDiagnosticsLines(
  diagnostics: WebRtcDiagnostics,
): string[] {
  const status = diagnostics.connectionStatus;
  const lines = [
    `webrtc phase=${status.phase} ready=${status.ready} pc=${status.peerConnectionState} ice=${diagnostics.iceConnectionState} gathering=${diagnostics.iceGatheringState} signaling=${diagnostics.signalingState}`,
    `webrtc channels signaling=${status.signalingJoined} control_dc=${status.controlChannelOpen} sync_dc=${status.syncChannelOpen} inbound_audio=${status.inboundAudioTrack} outbound_audio=${status.outboundAudioTrack}`,
    `webrtc stats reports=${diagnostics.stats.totalReports} pairs=${diagnostics.stats.candidatePairs} nominated=${diagnostics.stats.nominatedPairs} succeeded=${diagnostics.stats.succeededPairs} failed=${diagnostics.stats.failedPairs} relay_local=${diagnostics.stats.relayLocalCandidates} host_local=${diagnostics.stats.hostLocalCandidates} srflx_local=${diagnostics.stats.srflxLocalCandidates}`,
  ];

  if (diagnostics.stats.selectedPairId) {
    lines.push(
      `webrtc selected_pair id=${diagnostics.stats.selectedPairId} local=${diagnostics.stats.selectedLocalType ?? "?"} remote=${diagnostics.stats.selectedRemoteType ?? "?"} protocol=${diagnostics.stats.selectedProtocol ?? "?"}`,
    );
  } else {
    lines.push("webrtc selected_pair none");
  }

  return lines;
}
