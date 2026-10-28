import { connectBrowserVoiceSession } from "../../src/browser/browser-voice-session.ts";
import { getDefaultBrowserRuntime } from "../../src/browser/webrtc-runtime.ts";

type W = Window & {
  __lastAnswerSdp?: string;
  __connect?: (wsUrl: string, sessionId: string, preferStereoPlayback?: boolean, peerId?: string) => Promise<void>;
  __measure?: (ms: number) => Promise<{ leftRms: number; rightRms: number; channelCount: number }>;
  __close?: () => Promise<void>;
  __sessionErrors?: Array<{ code: string; message: string; recoverable?: boolean }>;
  __reconnects?: number;
  __connectionState?: () => string;
};
const w = window as unknown as W;
let audio: HTMLAudioElement | null = null;
let session: { close?: () => unknown; disconnect?: () => unknown } | null = null;

w.__sessionErrors = [];
w.__reconnects = 0;

w.__connect = async (wsUrl, sessionId, preferStereoPlayback, peerId = "client-browser") => {
  audio = document.createElement("audio");
  audio.autoplay = true;
  audio.muted = true;
  document.body.appendChild(audio);

  const base = getDefaultBrowserRuntime();
  const Native = base.RTCPeerConnection;
  class RecordingPc extends Native {
    override async setLocalDescription(desc?: RTCLocalSessionDescriptionInit): Promise<void> {
      if (desc?.sdp) {
        if (desc.type === "answer") w.__lastAnswerSdp = desc.sdp;
        return super.setLocalDescription(desc);
      }
      await super.setLocalDescription(desc);
      const cur = this.localDescription;
      if (cur?.type === "answer") w.__lastAnswerSdp = cur.sdp;
    }
  }
  const runtime = { ...base, RTCPeerConnection: RecordingPc as unknown as typeof Native };

  session = (await connectBrowserVoiceSession({
    credentials: {
      session_id: sessionId,
      mode: "voice+data",
      join_token: "",
      signaling_url: wsUrl,
      room_id: sessionId,
      ice_servers: [],
      expires_at: "",
    } as never,
    peerId,
    // No device in headless: falls back to a silent synthetic mic, which the host needs to start the voice client.
    requestMic: true,
    audioElement: audio,
    ...(preferStereoPlayback === undefined ? {} : { preferStereoPlayback }),
    runtime,
    onReconnecting: () => {
      w.__reconnects = (w.__reconnects ?? 0) + 1;
    },
    onSessionError: (event) => {
      w.__sessionErrors?.push({ code: event.code, message: event.message, recoverable: event.recoverable });
    },
  })) as never;
  w.__connectionState = () => (session as unknown as { getConnectionState(): string }).getConnectionState();

  const deadline = Date.now() + 20_000;
  for (;;) {
    const s = audio.srcObject as MediaStream | null;
    if (s && s.getAudioTracks().length > 0) break;
    if (Date.now() > deadline) throw new Error("no remote audio track on audio element");
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    await audio.play();
  } catch {
    /* autoplay flag should allow it; measurement works regardless */
  }
};

w.__measure = async (ms) => {
  const el = audio;
  if (!el?.srcObject) throw new Error("not connected");
  const ctx = new AudioContext();
  await ctx.resume();
  const source = ctx.createMediaStreamSource(el.srcObject as MediaStream);
  const splitter = ctx.createChannelSplitter(2);
  const aL = ctx.createAnalyser();
  const aR = ctx.createAnalyser();
  aL.fftSize = 2048;
  aR.fftSize = 2048;
  source.connect(splitter);
  splitter.connect(aL, 0);
  splitter.connect(aR, 1);
  const bufL = new Float32Array(aL.fftSize);
  const bufR = new Float32Array(aR.fftSize);
  let sL = 0;
  let sR = 0;
  let n = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    aL.getFloatTimeDomainData(bufL);
    aR.getFloatTimeDomainData(bufR);
    for (let i = 0; i < bufL.length; i++) {
      sL += bufL[i] * bufL[i];
      sR += bufR[i] * bufR[i];
    }
    n += bufL.length;
    await new Promise((r) => setTimeout(r, 20));
  }
  const channelCount = source.channelCount;
  await ctx.close();
  return { leftRms: Math.sqrt(sL / n), rightRms: Math.sqrt(sR / n), channelCount };
};

w.__close = async () => {
  try {
    await (session?.close?.() ?? session?.disconnect?.());
  } catch {
    /* ignore */
  }
  session = null;
};
