import { describe, expect, it } from "vitest";

import {
  formatWebRtcDiagnosticsLines,
  summarizeRtcStatsReport,
} from "./webrtc-diagnostics.js";
import { buildWebRtcConnectionStatus } from "./webrtc-connection-status.js";

function asStatsReport(
  entries: Array<[string, Record<string, unknown>]>,
): RTCStatsReport {
  return new Map(entries) as RTCStatsReport;
}

describe("summarizeRtcStatsReport", () => {
  it("counts candidate pairs and relay locals", () => {
    const stats = asStatsReport([
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
    ]);

    const summary = summarizeRtcStatsReport(stats);
    expect(summary.candidatePairs).toBe(2);
    expect(summary.succeededPairs).toBe(1);
    expect(summary.failedPairs).toBe(1);
    expect(summary.relayLocalCandidates).toBe(1);
    expect(summary.localCandidateReports).toBe(2);
    expect(summary.selectedLocalType).toBe("relay");
    expect(summary.selectedProtocol).toBe("udp");
  });

  it("resolves local/remote types for failed non-selected pairs", () => {
    const stats = asStatsReport([
      [
        "loc-host",
        { type: "local-candidate", candidateType: "host", protocol: "udp" },
      ],
      [
        "loc-srflx",
        { type: "local-candidate", candidateType: "srflx", protocol: "udp" },
      ],
      [
        "rem-relay",
        { type: "remote-candidate", candidateType: "relay", protocol: "udp" },
      ],
      [
        "pair-a",
        {
          type: "candidate-pair",
          state: "failed",
          nominated: false,
          selected: false,
          protocol: "udp",
          localCandidateId: "loc-host",
          remoteCandidateId: "rem-relay",
        },
      ],
      [
        "pair-b",
        {
          type: "candidate-pair",
          state: "failed",
          nominated: false,
          selected: false,
          protocol: "tcp",
          localCandidateId: "loc-srflx",
          remoteCandidateId: "rem-relay",
        },
      ],
    ]);

    const summary = summarizeRtcStatsReport(stats);
    expect(summary.selectedPairId).toBeUndefined();
    expect(summary.failedPairs).toBe(2);
    expect(summary.pairs).toHaveLength(2);
    expect(summary.pairs[0]).toMatchObject({
      id: "pair-a",
      state: "failed",
      nominated: false,
      selected: false,
      localType: "host",
      remoteType: "relay",
      protocol: "udp",
    });
    expect(summary.pairs[1]).toMatchObject({
      id: "pair-b",
      state: "failed",
      localType: "srflx",
      remoteType: "relay",
      protocol: "tcp",
    });
  });

  it("resolves pair types when candidate-pair rows precede candidate reports", () => {
    const stats = asStatsReport([
      [
        "pair-1",
        {
          type: "candidate-pair",
          state: "failed",
          nominated: false,
          selected: false,
          protocol: "udp",
          localCandidateId: "loc-relay",
          remoteCandidateId: "rem-host",
        },
      ],
      [
        "loc-relay",
        { type: "local-candidate", candidateType: "relay", protocol: "udp" },
      ],
      [
        "rem-host",
        { type: "remote-candidate", candidateType: "host", protocol: "udp" },
      ],
    ]);

    const summary = summarizeRtcStatsReport(stats);
    expect(summary.pairs[0]).toMatchObject({
      localType: "relay",
      remoteType: "host",
    });
    expect(summary.relayLocalCandidates).toBe(1);
    expect(summary.localCandidateReports).toBe(1);
  });

  it("leaves unresolved candidate references as missing types", () => {
    const stats = asStatsReport([
      [
        "pair-missing",
        {
          type: "candidate-pair",
          state: "failed",
          nominated: false,
          selected: false,
          protocol: "udp",
          localCandidateId: "missing-local",
          remoteCandidateId: "missing-remote",
        },
      ],
    ]);

    const summary = summarizeRtcStatsReport(stats);
    expect(summary.localCandidateReports).toBe(0);
    expect(summary.pairs[0]?.localType).toBeUndefined();
    expect(summary.pairs[0]?.remoteType).toBeUndefined();
  });

  it("counts prflx and unknown local candidate types", () => {
    const stats = asStatsReport([
      [
        "loc-prflx",
        { type: "local-candidate", candidateType: "prflx", protocol: "udp" },
      ],
      [
        "loc-weird",
        { type: "local-candidate", candidateType: "custom", protocol: "udp" },
      ],
      ["loc-missing-type", { type: "local-candidate", protocol: "udp" }],
    ]);

    const summary = summarizeRtcStatsReport(stats);
    expect(summary.prflxLocalCandidates).toBe(1);
    expect(summary.unknownLocalCandidates).toBe(2);
    expect(summary.localCandidateReports).toBe(3);
    expect(summary.hostLocalCandidates).toBe(0);
    expect(summary.srflxLocalCandidates).toBe(0);
    expect(summary.relayLocalCandidates).toBe(0);
  });

  it("falls back to local-candidate protocol when the pair omits protocol", () => {
    const stats = asStatsReport([
      [
        "loc-host",
        { type: "local-candidate", candidateType: "host", protocol: "tcp" },
      ],
      [
        "rem-host",
        { type: "remote-candidate", candidateType: "host", protocol: "tcp" },
      ],
      [
        "pair-1",
        {
          type: "candidate-pair",
          state: "failed",
          nominated: false,
          selected: false,
          localCandidateId: "loc-host",
          remoteCandidateId: "rem-host",
        },
      ],
    ]);

    const summary = summarizeRtcStatsReport(stats);
    expect(summary.pairs?.[0]?.protocol).toBe("tcp");
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
    expect(lines[2]).toContain("prflx_local=0");
    expect(lines[2]).toContain("unknown_local=0");
    expect(lines[2]).toContain("local_reports=0");
    expect(lines.at(-1)).toContain("selected_pair none");
  });

  it("prints per-pair lines with ? for missing types and omits fixture addresses", () => {
    const fixtureIp = "203.0.113.44";
    const fixturePort = "3478";
    const fixtureUrl = "turn:turn.example.test:3478?transport=udp";

    const stats = asStatsReport([
      [
        "loc-host",
        {
          type: "local-candidate",
          candidateType: "host",
          protocol: "udp",
          address: fixtureIp,
          port: Number(fixturePort),
          url: fixtureUrl,
        },
      ],
      [
        "rem-srflx",
        {
          type: "remote-candidate",
          candidateType: "srflx",
          protocol: "udp",
          address: "198.51.100.9",
          port: 50000,
        },
      ],
      [
        "pair-ok",
        {
          type: "candidate-pair",
          state: "failed",
          nominated: false,
          selected: false,
          protocol: "udp",
          localCandidateId: "loc-host",
          remoteCandidateId: "rem-srflx",
        },
      ],
      [
        "pair-missing",
        {
          type: "candidate-pair",
          state: "failed",
          nominated: false,
          selected: false,
          protocol: "udp",
          localCandidateId: "gone-local",
          remoteCandidateId: "gone-remote",
        },
      ],
    ]);

    const summary = summarizeRtcStatsReport(stats);
    const lines = formatWebRtcDiagnosticsLines({
      peerConnectionState: "failed",
      iceConnectionState: "failed",
      iceGatheringState: "complete",
      signalingState: "stable",
      connectionStatus: buildWebRtcConnectionStatus(
        {
          signalingJoined: true,
          peerConnectionState: "failed",
          inboundAudioTrack: false,
          outboundAudioTrack: false,
          controlChannelOpen: false,
          syncChannelOpen: false,
        },
        "voice",
      ),
      stats: summary,
    });

    const joined = lines.join("\n");
    expect(joined).toContain(
      "webrtc pair state=failed nominated=false selected=false local=host remote=srflx protocol=udp",
    );
    expect(joined).toContain(
      "webrtc pair state=failed nominated=false selected=false local=? remote=? protocol=udp",
    );
    expect(joined).not.toContain(fixtureIp);
    expect(joined).not.toContain(fixturePort);
    expect(joined).not.toContain(fixtureUrl);
    expect(joined).not.toContain("198.51.100.9");
    expect(joined).not.toContain("50000");
    expect(joined).toContain("selected_pair none");
    expect(joined).toContain("prflx_local=0");
    expect(joined).toContain("local_reports=1");
  });
});
