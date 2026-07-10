import { describe, expect, it } from "vitest";

import {
  formatWebRtcDiagnosticsLines,
  summarizeRtcStatsReport,
} from "./webrtc-diagnostics.js";
import { buildWebRtcConnectionStatus } from "./webrtc-connection-status.js";

describe("summarizeRtcStatsReport", () => {
  it("counts candidate pairs and relay locals", () => {
    const stats = new Map<string, Record<string, unknown>>([
      [
        "loc-relay",
        { type: "local-candidate", candidateType: "relay", protocol: "udp" },
      ],
      [
        "loc-host",
        { type: "local-candidate", candidateType: "host", protocol: "udp" },
      ],
      [
        "rem-host",
        { type: "remote-candidate", candidateType: "host", protocol: "udp" },
      ],
      [
        "pair-1",
        {
          type: "candidate-pair",
          state: "failed",
          nominated: false,
          localCandidateId: "loc-relay",
          remoteCandidateId: "rem-host",
        },
      ],
      [
        "pair-2",
        {
          type: "candidate-pair",
          state: "succeeded",
          nominated: true,
          selected: true,
          protocol: "udp",
          localCandidateId: "loc-relay",
          remoteCandidateId: "rem-host",
        },
      ],
    ]) as RTCStatsReport;

    const summary = summarizeRtcStatsReport(stats);
    expect(summary.candidatePairs).toBe(2);
    expect(summary.succeededPairs).toBe(1);
    expect(summary.failedPairs).toBe(1);
    expect(summary.relayLocalCandidates).toBe(1);
    expect(summary.selectedLocalType).toBe("relay");
    expect(summary.selectedProtocol).toBe("udp");
  });
});

describe("formatWebRtcDiagnosticsLines", () => {
  it("includes phase and selected pair", () => {
    const lines = formatWebRtcDiagnosticsLines({
      peerConnectionState: "connecting",
      iceConnectionState: "checking",
      iceGatheringState: "complete",
      signalingState: "stable",
      connectionStatus: buildWebRtcConnectionStatus(
        {
          signalingJoined: true,
          peerConnectionState: "connecting",
          inboundAudioTrack: false,
          outboundAudioTrack: false,
          controlChannelOpen: false,
          syncChannelOpen: false,
        },
        "data",
      ),
      stats: {
        totalReports: 4,
        candidatePairs: 1,
        nominatedPairs: 0,
        succeededPairs: 0,
        failedPairs: 1,
        relayLocalCandidates: 1,
        hostLocalCandidates: 0,
        srflxLocalCandidates: 0,
      },
    });

    expect(lines[0]).toContain("phase=connecting");
    expect(lines[0]).toContain("ice=checking");
    expect(lines.at(-1)).toContain("selected_pair none");
  });
});
