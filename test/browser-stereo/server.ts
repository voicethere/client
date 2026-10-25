/**
 * Test server for the Chromium stereo listener harness.
 * Hosts a SessionPod with three sessions: a Node source (440 Hz dual-mono tone, panned hard left),
 * a session for the browser listener and a session for a Node listener.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SessionPod, VoiceSessionBudget, resetProcessVoiceSessionBudget } from "@node-webrtc-rust/helpers";
import { LocalAudioTrack, RemoteAudioTrack, RTCPeerConnection } from "@node-webrtc-rust/sdk";
import { quatIdentity, vec3Zero } from "@node-webrtc-rust/sdk/mix";

// The helpers package depends on its own signaling version (0.13.x); the client runtime
// dependency is older. Load the one helpers uses so server and pod agree.
const requireFromHere = createRequire(import.meta.url);
const helpersDir = path.dirname(path.dirname(requireFromHere.resolve("@node-webrtc-rust/helpers")));
const signalingEntry = path.join(
  path.dirname(helpersDir),
  "node_modules/@node-webrtc-rust/signaling/dist/esm/index.js",
);
const signalingModule = (await import(pathToFileURL(signalingEntry).href)) as typeof import("@node-webrtc-rust/signaling");
const { SignalingServer, SignalingClient, autoNegotiate } = signalingModule;

const SOURCE_PEER = "client-src";
const SOURCE_SESSION = "session-src";
const LISTEN_SESSION = "session-listen";
const NODE_SESSION = "session-node";
const NODE_PEER = "client-node";

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

export type StereoMixServer = {
  wsUrl: string;
  listenerSessionId: string;
  nodeListenerSessionId: string;
  configureMix(browserPeerId: string, nodePeerId: string): Promise<void>;
  measureNodeListener(ms: number): Promise<InboundRms>;
  close(): Promise<void>;
};

export async function startStereoMixServer(): Promise<StereoMixServer> {
  resetProcessVoiceSessionBudget();
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
  } as ConstructorParameters<typeof SessionPod>[1]);
  for (const id of [SOURCE_SESSION, LISTEN_SESSION, NODE_SESSION]) {
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
    [SOURCE_SESSION, LISTEN_SESSION, NODE_SESSION].some((s) => hostFor(s)?.isVoiceClientActive(peerId));
  const waitActive = async (peerId: string, timeoutMs = 20_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (anyActive(peerId)) return;
      await delay(50);
    }
    throw new Error(`timed out waiting for active voice client ${peerId}`);
  };

  return {
    wsUrl,
    listenerSessionId: LISTEN_SESSION,
    nodeListenerSessionId: NODE_SESSION,
    async configureMix(browserPeerId, nodePeerId) {
      for (const id of [SOURCE_PEER, browserPeerId, nodePeerId]) await waitActive(id);
      const host = hostFor(LISTEN_SESSION);
      if (!host) throw new Error("no host for listener session");
      host.createMixGroup({ id: "all", clientIds: [SOURCE_PEER, browserPeerId, nodePeerId] });
      host.setPositionalMixing(true);
      host.setClientPose(browserPeerId, centerPose);
      host.setClientPose(nodePeerId, centerPose);
      host.setClientPose(SOURCE_PEER, poseAtX(-3));
    },
    measureNodeListener: (ms) => meter.measure(ms),
    async close() {
      stopped = true;
      meter.stop();
      await pump.catch(() => undefined);
      source.close();
      nodeListener.close();
      await pod.close().catch(() => undefined);
      resetProcessVoiceSessionBudget();
    },
  };
}
