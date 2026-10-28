/**
 * Test server for the Chromium stereo listener harness.
 * Hosts a SessionPod with three sessions: a Node source (440 Hz dual-mono tone, panned hard left),
 * a session for the browser listener and a session for a Node listener.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SessionPod, VoiceSessionBudget, resetProcessVoiceSessionBudget } from "@node-webrtc-rust/helpers";
import { LocalAudioTrack, RemoteAudioTrack, RTCPeerConnection } from "@node-webrtc-rust/sdk";
import { quatIdentity, vec3Zero } from "@node-webrtc-rust/sdk/mix";

import { connectBrowserVoiceSession } from "../../src/browser/browser-voice-session.ts";
import { createNodeWebRtcRuntime } from "../../src/node/index.ts";

// The helpers package depends on its own signaling version (0.13.x); the client runtime
// dependency is older. Resolve the copy helpers uses so server and pod agree.
const requireFromHere = createRequire(import.meta.url);
const requireFromHelpers = createRequire(requireFromHere.resolve("@node-webrtc-rust/helpers"));
const signalingEntry = requireFromHelpers.resolve("@node-webrtc-rust/signaling");

/** Nearest package.json above a resolved entry file (the packages do not export ./package.json). */
function packageVersionOf(entry: string): string {
  let dir = path.dirname(entry);
  for (;;) {
    const file = path.join(dir, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@node-webrtc-rust/signaling") return pkg.version ?? "";
    }
    const parent = path.dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}
const signalingVersion = packageVersionOf(signalingEntry);
if (!signalingVersion.startsWith("0.13.")) {
  throw new Error(
    `StereoHarnessSignalingVersionError: helpers uses signaling ${signalingVersion || "unknown"}, expected 0.13.x`,
  );
}
const signalingImported = (await import(pathToFileURL(signalingEntry).href)) as Record<string, unknown> & {
  default?: Record<string, unknown>;
};
const signalingModule = (signalingImported.SignalingServer
  ? signalingImported
  : signalingImported.default) as typeof import("@node-webrtc-rust/signaling");
const { SignalingServer, SignalingClient, autoNegotiate } = signalingModule;

const SOURCE_PEER = "client-src";
const SOURCE_SESSION = "session-src";
const LISTEN_SESSION = "session-listen";
const NODE_SESSION = "session-node";
const NODE_PEER = "client-node";
const CLIENT_NODE_SESSION = "session-node-client";
const CLIENT_NODE_PEER = "client-node-client";
const CLOSE_BROWSER_SESSION = "session-close-browser";
const CLOSE_NODE_SESSION = "session-close-node";
const CLOSE_NODE_PEER = "client-close-node";

const SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = 960;
const FRAME_BYTES = FRAME_SAMPLES * 4;
const FRAME_MS = 20;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Host = {
  isVoiceClientActive(id: string): boolean;
  createMixGroup(o: { id: string; clientIds: string[] }): void;
  setPositionalMixing(on: boolean): void;
  setClientPose(id: string, pose: unknown): void;
};

type PodAccess = { slots: Map<string, { host: Host }> };

const centerPose = { position: vec3Zero(), orientation: quatIdentity() };
const poseAtX = (x: number) => ({ position: { ...vec3Zero(), x }, orientation: quatIdentity() });

function sineFrame(n: number): Buffer {
  const pcm = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const t = (n * FRAME_SAMPLES + i) / SAMPLE_RATE;
    const v = Math.round(0.3 * 32767 * Math.sin(2 * Math.PI * 440 * t));
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  return pcm;
}

async function waitForConnection(pc: RTCPeerConnection, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pc.connectionState === "connected") return;
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      throw new Error(`connection ${pc.connectionState}`);
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for connection (state=${pc.connectionState})`);
}

type Connected = {
  pc: RTCPeerConnection;
  mic: LocalAudioTrack;
  agentAudio: RemoteAudioTrack;
  close(): void;
};

async function connectClientToSession(wsUrl: string, sessionId: string, peerId: string): Promise<Connected> {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const mic = new LocalAudioTrack(`${peerId}-mic`, `stream-${peerId}`);
  await pc.addTrack(mic);
  const signaling = new SignalingClient({ url: wsUrl, room: sessionId, peerId });
  const agentAudioPromise = new Promise<RemoteAudioTrack>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for agent audio (${peerId})`)), 30_000);
    pc.ontrack = (event) => {
      if (event.track instanceof RemoteAudioTrack) {
        clearTimeout(timer);
        resolve(event.track);
      }
    };
  });
  agentAudioPromise.catch(() => undefined);
  const teardown = autoNegotiate({ pc, signaling, polite: true });
  try {
    await signaling.connect();
    await waitForConnection(pc);
    await mic.writeSample(Buffer.alloc(960), 5);
    const agentAudio = await agentAudioPromise;
    return {
      pc,
      mic,
      agentAudio,
      close: () => {
        teardown();
        pc.close();
        signaling.disconnect();
      },
    };
  } catch (error) {
    teardown();
    pc.close();
    signaling.disconnect();
    throw error;
  }
}

export type InboundRms = { left: number; right: number };

/** Drains a remote track continuously and exposes windowed L/R RMS (s16le interleaved stereo). */
function createInboundMeter(track: RemoteAudioTrack) {
  let stopped = false;
  let sumL = 0;
  let sumR = 0;
  let n = 0;
  void (async () => {
    while (!stopped) {
      try {
        const sample = await track.readSample();
        if (!sample || sample.byteLength < 4) continue;
        const bytes = Buffer.from(sample);
        const pairs = Math.floor(bytes.byteLength / 4);
        for (let i = 0; i < pairs; i++) {
          const l = bytes.readInt16LE(i * 4);
          const r = bytes.readInt16LE(i * 4 + 2);
          sumL += l * l;
          sumR += r * r;
        }
        n += pairs;
      } catch {
        break;
      }
    }
  })();
  return {
    async measure(ms: number): Promise<InboundRms> {
      sumL = 0;
      sumR = 0;
      n = 0;
      await delay(ms);
      // Full-scale s16 -> [-1, 1] so values compare with the browser's float samples.
      return n === 0
        ? { left: 0, right: 0 }
        : { left: Math.sqrt(sumL / n) / 32768, right: Math.sqrt(sumR / n) / 32768 };
    },
    stop() {
      stopped = true;
    },
  };
}

export type CloseObserver = {
  peerId: string;
  sessionId: string;
  errors: Array<{ code: string; message: string; recoverable?: boolean }>;
  reconnects: () => number;
  state: () => string;
};

export type StereoMixServer = {
  wsUrl: string;
  listenerSessionId: string;
  nodeListenerSessionId: string;
  configureMix(browserPeerId: string, nodePeerId: string, clientNodePeerId?: string): Promise<void>;
  /** Joins with the client's own Node runtime (`connectBrowserVoiceSession` + `createNodeWebRtcRuntime`). */
  connectClientNodeListener(): Promise<{ peerId: string; measure(ms: number): Promise<InboundRms> }>;
  measureNodeListener(ms: number): Promise<InboundRms>;
  closeBrowserSessionId: string;
  /** Joins the close-test session with the client's Node runtime and records session errors and reconnects. */
  connectCloseNodeClient(): Promise<CloseObserver>;
  /**
   * Server-side time-limit close, same order as the runner: send `session_close`, flush the control
   * channel, then tear the session down.
   */
  sendTimeLimitCloseAndTeardown(peerId: string, sessionId: string, message: string): Promise<void>;
  close(): Promise<void>;
};

export async function startStereoMixServer(): Promise<StereoMixServer> {
  resetProcessVoiceSessionBudget();
  const peerContexts = new Map<
    string,
    { peerId: string; sendToClient: (p: unknown) => void; flushToClient?: () => Promise<boolean> }
  >();
  const server = new SignalingServer({ port: 0 });
  await server.listen(0, "127.0.0.1");
  const wsUrl = `ws://127.0.0.1:${server.port}`;
  const pod = new SessionPod(server, {
    signalingUrl: wsUrl,
    iceServers: [],
    sessionMode: "voice+data",
    teardownIdleSessions: false,
    voiceConfig: { stt: { provider: "mock" }, tts: { provider: "mock" } },
    sessionBudget: new VoiceSessionBudget(8),
    maxPreparedSessions: 8,
    voiceHandler: {
      onPeerConnected: (ctx: { peerId: string; sendToClient: (p: unknown) => void; flushToClient?: () => Promise<boolean> }) => {
        peerContexts.set(ctx.peerId, ctx);
      },
    },
  } as ConstructorParameters<typeof SessionPod>[1]);
  for (const id of [SOURCE_SESSION, LISTEN_SESSION, NODE_SESSION, CLIENT_NODE_SESSION, CLOSE_BROWSER_SESSION, CLOSE_NODE_SESSION]) {
    await pod.ensureSession(id);
  }

  const source = await connectClientToSession(wsUrl, SOURCE_SESSION, SOURCE_PEER);
  const nodeListener = await connectClientToSession(wsUrl, NODE_SESSION, NODE_PEER);
  const meter = createInboundMeter(nodeListener.agentAudio);

  // Anchor-paced tone: frame n is due at t0 + n * 20 ms.
  let stopped = false;
  const pump = (async () => {
    const t0 = performance.now();
    let n = 0;
    while (!stopped) {
      const due = t0 + n * FRAME_MS;
      if (performance.now() >= due) {
        await source.mic.writeSample(sineFrame(n), FRAME_MS);
        n++;
      } else {
        await delay(Math.max(1, Math.min(5, due - performance.now())));
      }
    }
  })();
  pump.catch(() => undefined);

  const hostFor = (sessionId: string): Host | undefined => (pod as unknown as PodAccess).slots.get(sessionId)?.host;
  const anyActive = (peerId: string): boolean =>
    [SOURCE_SESSION, LISTEN_SESSION, NODE_SESSION, CLIENT_NODE_SESSION].some((s) => hostFor(s)?.isVoiceClientActive(peerId));
  const waitActive = async (peerId: string, timeoutMs = 20_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (anyActive(peerId)) return;
      await delay(50);
    }
    throw new Error(`timed out waiting for active voice client ${peerId}`);
  };

  const clientNodeCloses: Array<() => unknown> = [];
  const clientNodeMeters: Array<{ stop(): void }> = [];

  return {
    wsUrl,
    listenerSessionId: LISTEN_SESSION,
    nodeListenerSessionId: NODE_SESSION,
    async connectClientNodeListener() {
      let resolveTrack!: (t: RemoteAudioTrack) => void;
      const trackPromise = new Promise<RemoteAudioTrack>((resolve) => {
        resolveTrack = resolve;
      });
      const session = await connectBrowserVoiceSession({
        credentials: {
          session_id: CLIENT_NODE_SESSION,
          mode: "voice+data",
          join_token: "",
          signaling_url: wsUrl,
          room_id: CLIENT_NODE_SESSION,
          ice_servers: [],
          expires_at: "",
        } as never,
        peerId: CLIENT_NODE_PEER,
        requestMic: true,
        runtime: createNodeWebRtcRuntime(),
        onAgentAudioTrack: (track) => resolveTrack(track as unknown as RemoteAudioTrack),
      });
      clientNodeCloses.push(() => (session as { close?: () => unknown }).close?.());
      const track = await Promise.race([
        trackPromise,
        delay(30_000).then(() => {
          throw new Error("timed out waiting for agent audio (client Node runtime)");
        }),
      ]);
      const m = createInboundMeter(track);
      clientNodeMeters.push(m);
      return { peerId: CLIENT_NODE_PEER, measure: (ms) => m.measure(ms) };
    },
    async configureMix(browserPeerId, nodePeerId, clientNodePeerId) {
      const peers = [SOURCE_PEER, browserPeerId, nodePeerId, clientNodePeerId ?? ""].filter((id) => id !== "");
      for (const id of peers) await waitActive(id);
      const host = hostFor(LISTEN_SESSION);
      if (!host) throw new Error("no host for listener session");
      host.createMixGroup({ id: "all", clientIds: peers });
      host.setPositionalMixing(true);
      if (browserPeerId) host.setClientPose(browserPeerId, centerPose);
      host.setClientPose(nodePeerId, centerPose);
      if (clientNodePeerId) host.setClientPose(clientNodePeerId, centerPose);
      host.setClientPose(SOURCE_PEER, poseAtX(-3));
    },
    measureNodeListener: (ms) => meter.measure(ms),
    closeBrowserSessionId: CLOSE_BROWSER_SESSION,
    async connectCloseNodeClient() {
      const errors: CloseObserver["errors"] = [];
      let reconnects = 0;
      const session = await connectBrowserVoiceSession({
        credentials: {
          session_id: CLOSE_NODE_SESSION,
          mode: "voice+data",
          join_token: "",
          signaling_url: wsUrl,
          room_id: CLOSE_NODE_SESSION,
          ice_servers: [],
          expires_at: "",
        } as never,
        peerId: CLOSE_NODE_PEER,
        requestMic: true,
        runtime: createNodeWebRtcRuntime(),
        onReconnecting: () => {
          reconnects++;
        },
        onSessionError: (event) => {
          errors.push({ code: event.code, message: event.message, recoverable: event.recoverable });
        },
      });
      clientNodeCloses.push(() => (session as { close?: () => unknown }).close?.());
      return {
        peerId: CLOSE_NODE_PEER,
        sessionId: CLOSE_NODE_SESSION,
        errors,
        reconnects: () => reconnects,
        state: () => session.getConnectionState(),
      };
    },
    async sendTimeLimitCloseAndTeardown(peerId, sessionId, message) {
      const deadline = Date.now() + 20_000;
      while (!peerContexts.has(peerId)) {
        if (Date.now() > deadline) throw new Error(`no voice context for ${peerId}`);
        await delay(50);
      }
      const ctx = peerContexts.get(peerId)!;
      ctx.sendToClient({ type: "session_close", code: "max_session_length", message });
      await ctx.flushToClient?.();
      await pod.teardownSession(sessionId, "max_session_length");
    },
    async close() {
      stopped = true;
      meter.stop();
      for (const m of clientNodeMeters) m.stop();
      for (const c of clientNodeCloses) {
        try {
          await c();
        } catch {
          /* ignore */
        }
      }
      await pump.catch(() => undefined);
      source.close();
      nodeListener.close();
      await pod.close().catch(() => undefined);
      resetProcessVoiceSessionBudget();
    },
  };
}
