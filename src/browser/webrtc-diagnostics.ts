import type { WebRtcConnectionStatus } from "./webrtc-connection-status.js";

/** Compact ICE candidate-pair row for diagnostics (types/state only — no addresses). */
export type WebRtcIceCandidatePairSummary = {
  id: string;
  state?: string;
  nominated: boolean;
  selected: boolean;
  protocol?: string;
  /** Local candidateType, or omitted when the referenced report is missing. */
  localType?: string;
  /** Remote candidateType, or omitted when the referenced report is missing. */
  remoteType?: string;
};

export type WebRtcStatsSummary = {
  totalReports: number;
  candidatePairs: number;
  nominatedPairs: number;
  succeededPairs: number;
  failedPairs: number;
  relayLocalCandidates: number;
  hostLocalCandidates: number;
  srflxLocalCandidates: number;
  /** Optional for consumers/mocks built against older summary shapes. */
  prflxLocalCandidates?: number;
  /** Local candidates with missing or unrecognized candidateType. */
  unknownLocalCandidates?: number;
  /** Count of `local-candidate` stats reports (distinct from type buckets). */
  localCandidateReports?: number;
  /**
   * Per-pair diagnostics (all pairs, safely capped). Types resolve via candidate
   * id lookup after collecting local/remote reports — independent of report order.
   */
  pairs?: WebRtcIceCandidatePairSummary[];
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

/** Max pairs retained on {@link WebRtcStatsSummary.pairs}. */
const MAX_STORED_PAIRS = 32;
/** Max `webrtc pair …` lines emitted by {@link formatWebRtcDiagnosticsLines}. */
const MAX_FORMATTED_PAIRS = 8;

function emptyStatsSummary(): WebRtcStatsSummary {
  return {
    totalReports: 0,
    candidatePairs: 0,
    nominatedPairs: 0,
    succeededPairs: 0,
    failedPairs: 0,
    relayLocalCandidates: 0,
    hostLocalCandidates: 0,
    srflxLocalCandidates: 0,
    prflxLocalCandidates: 0,
    unknownLocalCandidates: 0,
    localCandidateReports: 0,
    pairs: [],
  };
}

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

function candidateTypeOf(
  candidates: Map<string, Record<string, unknown>>,
  id: string | undefined,
): string | undefined {
  if (!id) return undefined;
  const row = candidates.get(id);
  if (!row) return undefined;
  return readString(row, "candidateType");
}

function candidateProtocolOf(
  candidates: Map<string, Record<string, unknown>>,
  id: string | undefined,
): string | undefined {
  if (!id) return undefined;
  const row = candidates.get(id);
  if (!row) return undefined;
  return readString(row, "protocol");
}

/** Summarize {@link RTCPeerConnection.getStats} for logs (candidate pairs, relay usage). */
export function summarizeRtcStatsReport(
  stats: RTCStatsReport,
): WebRtcStatsSummary {
  const locals = new Map<string, Record<string, unknown>>();
  const remotes = new Map<string, Record<string, unknown>>();
  const pairRows: Array<{ id: string; row: Record<string, unknown> }> = [];

  let relayLocalCandidates = 0;
  let hostLocalCandidates = 0;
  let srflxLocalCandidates = 0;
  let prflxLocalCandidates = 0;
  let unknownLocalCandidates = 0;
  let localCandidateReports = 0;

  // Pass 1: collect candidates and pair rows so resolution is order-independent.
  stats.forEach((report, id) => {
    const row = report as Record<string, unknown>;
    const type = readString(row, "type");
    if (type === "local-candidate") {
      locals.set(id, row);
      localCandidateReports += 1;
      const candidateType = readString(row, "candidateType");
      if (candidateType === "relay") relayLocalCandidates += 1;
      else if (candidateType === "host") hostLocalCandidates += 1;
      else if (candidateType === "srflx") srflxLocalCandidates += 1;
      else if (candidateType === "prflx") prflxLocalCandidates += 1;
      else unknownLocalCandidates += 1;
      return;
    }
    if (type === "remote-candidate") {
      remotes.set(id, row);
      return;
    }
    if (type === "candidate-pair") {
      pairRows.push({ id, row });
    }
  });

  let nominatedPairs = 0;
  let succeededPairs = 0;
  let failedPairs = 0;
  let selectedPairId: string | undefined;
  let selectedLocalType: string | undefined;
  let selectedRemoteType: string | undefined;
  let selectedProtocol: string | undefined;
  let selectedIsExplicit = false;
  const pairs: WebRtcIceCandidatePairSummary[] = [];

  for (const { id, row } of pairRows) {
    const nominated = readBool(row, "nominated");
    const selected = readBool(row, "selected");
    const state = readString(row, "state");
    const localCandidateId = readString(row, "localCandidateId");
    const remoteCandidateId = readString(row, "remoteCandidateId");
    const protocol =
      readString(row, "protocol") ??
      candidateProtocolOf(locals, localCandidateId);
    const localType = candidateTypeOf(locals, localCandidateId);
    const remoteType = candidateTypeOf(remotes, remoteCandidateId);

    if (nominated) nominatedPairs += 1;
    if (state === "succeeded") succeededPairs += 1;
    if (state === "failed") failedPairs += 1;

    if (pairs.length < MAX_STORED_PAIRS) {
      pairs.push({
        id,
        state,
        nominated,
        selected,
        protocol,
        localType,
        remoteType,
      });
    }

    // Prefer an explicitly selected pair; otherwise keep last nominated (legacy).
    if (selected || nominated) {
      if (selected || !selectedIsExplicit) {
        selectedPairId = id;
        selectedProtocol = protocol;
        selectedLocalType = localType;
        selectedRemoteType = remoteType;
        selectedIsExplicit = selected;
      }
    }
  }

  return {
    totalReports: stats.size,
    candidatePairs: pairRows.length,
    nominatedPairs,
    succeededPairs,
    failedPairs,
    relayLocalCandidates,
    hostLocalCandidates,
    srflxLocalCandidates,
    prflxLocalCandidates,
    unknownLocalCandidates,
    localCandidateReports,
    pairs,
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

  let stats: WebRtcStatsSummary = emptyStatsSummary();

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
  const s = diagnostics.stats;
  const prflxLocal = s.prflxLocalCandidates ?? 0;
  const unknownLocal = s.unknownLocalCandidates ?? 0;
  const localReports = s.localCandidateReports ?? 0;
  const pairs = s.pairs ?? [];
  const lines = [
    `webrtc phase=${status.phase} ready=${status.ready} pc=${status.peerConnectionState} ice=${diagnostics.iceConnectionState} gathering=${diagnostics.iceGatheringState} signaling=${diagnostics.signalingState}`,
    `webrtc channels signaling=${status.signalingJoined} control_dc=${status.controlChannelOpen} sync_dc=${status.syncChannelOpen} inbound_audio=${status.inboundAudioTrack} outbound_audio=${status.outboundAudioTrack}`,
    `webrtc stats reports=${s.totalReports} pairs=${s.candidatePairs} nominated=${s.nominatedPairs} succeeded=${s.succeededPairs} failed=${s.failedPairs} relay_local=${s.relayLocalCandidates} host_local=${s.hostLocalCandidates} srflx_local=${s.srflxLocalCandidates} prflx_local=${prflxLocal} unknown_local=${unknownLocal} local_reports=${localReports}`,
  ];

  if (s.selectedPairId) {
    lines.push(
      `webrtc selected_pair id=${s.selectedPairId} local=${s.selectedLocalType ?? "?"} remote=${s.selectedRemoteType ?? "?"} protocol=${s.selectedProtocol ?? "?"}`,
    );
  } else {
    lines.push("webrtc selected_pair none");
  }

  for (const pair of pairs.slice(0, MAX_FORMATTED_PAIRS)) {
    lines.push(
      `webrtc pair state=${pair.state ?? "?"} nominated=${pair.nominated} selected=${pair.selected} local=${pair.localType ?? "?"} remote=${pair.remoteType ?? "?"} protocol=${pair.protocol ?? "?"}`,
    );
  }

  return lines;
}
