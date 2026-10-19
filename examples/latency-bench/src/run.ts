/**
 * End-to-end turn latency against your own deployed VoiceThere agent.
 *
 *   VOICETHERE_CLIENT_API_KEY=vthc_… VOICETHERE_PROJECT_ID=<uuid> \
 *     npx tsx examples/latency-bench/src/run.ts --clip counting.wav --out results/my-run
 *
 * See ../README.md. Output files: raw.jsonl, meta.json, environment.json.
 */
import { readFile } from "node:fs/promises";

import {
  connectBrowserVoiceSession,
  createNodeWebRtcRuntime,
  startSession,
  type BrowserVoiceSession,
} from "../../../src/node/index.js";
import { parseBenchArgs, type BenchArgs } from "./args.js";
import { collectEnvironment } from "./environment.js";
import {
  computeTurnMetrics,
  parseSpeechEvent,
  type SpeechEventRecord,
} from "./metrics.js";
import { PacedMicPump, type PumpTrack } from "./pacing.js";
import {
  buildRecord,
  prepareOutDir,
  writeResults,
  type BenchMeta,
  type BenchRecord,
} from "./records.js";
import { SuspendWatch } from "./suspend-watch.js";
import { clipToFrames, decodeWav } from "./wav.js";

/** Quiet time before a turn so the voice activity detector sees silence first. */
const LEAD_SILENCE_MS = 1000;
/** Quiet time after a reply before the next turn. */
const TAIL_SILENCE_MS = 1500;
const CONNECT_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

function micTrack(session: BrowserVoiceSession): PumpTrack {
  const track = session.getMicStream()?.getAudioTracks()[0] as unknown as
    PumpTrack | undefined;
  if (!track || typeof track.writeSample !== "function") {
    throw new Error(
      "mic track has no writeSample (Node WebRTC runtime needed)",
    );
  }
  return track;
}

async function runConversation(
  args: BenchArgs,
  apiKey: string,
  frames: Uint8Array[],
  firstRun: number,
  records: BenchRecord[],
): Promise<number> {
  const events: SpeechEventRecord[] = [];
  const provision = await startSession({
    apiBase: args.apiBase,
    projectId: args.projectId,
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!provision.ok) {
    throw new Error(`could not start a session: ${provision.code}`);
  }

  const session = await connectBrowserVoiceSession({
    credentials: provision.credentials,
    runtime: createNodeWebRtcRuntime(),
    requestMic: true,
    // We own writeSample on the mic track: the pump below is the only writer.
    micPump: "external",
    onControlMessage: (message) => {
      const event = parseSpeechEvent(message, now());
      if (event) events.push(event);
    },
  });
  const pump = new PacedMicPump(micTrack(session));
  let failed = 0;
  try {
    // RTP must flow before the connection reaches "connected".
    pump.start();
    await session.waitForConnected(CONNECT_TIMEOUT_MS);
    // Let a greeting from the agent finish before the first turn.
    await sleep(2000);
    await waitFor(() => !agentIsSpeaking(events), 15_000);

    for (let turn = 0; turn < args.turns; turn++) {
      await sleep(LEAD_SILENCE_MS);
      const startIndex = events.length;
      const speechEndAtMs = await pump.play(frames);
      const answered = await waitFor(
        () => replyStarted(events.slice(startIndex)),
        args.turnTimeoutMs,
      );
      const metrics = computeTurnMetrics({
        speechEndAtMs,
        events: events.slice(startIndex),
      });
      if (!answered) failed += 1;
      else {
        records.push(
          buildRecord({
            model: args.model,
            turnIndexInConversation: turn,
            run: firstRun + turn,
            metrics,
          }),
        );
      }
      console.log(
        `turn ${turn + 1}/${args.turns}: ` +
          (answered
            ? `speech_end_to_reply_start_ms=${Math.round(metrics.speech_end_to_reply_start_ms ?? NaN)}`
            : "no reply"),
      );
      // Wait for the reply to finish so it does not overlap the next turn.
      await waitFor(() => !agentIsSpeaking(events), args.turnTimeoutMs);
      await sleep(TAIL_SILENCE_MS);
    }
  } finally {
    await pump.stop();
    await session.disconnectAsync().catch(() => undefined);
  }
  return failed;
}

function replyStarted(events: SpeechEventRecord[]): boolean {
  const metrics = computeTurnMetrics({ speechEndAtMs: null, events });
  return metrics.final_to_reply_start_ms != null;
}

function agentIsSpeaking(events: SpeechEventRecord[]): boolean {
  const last = events
    .filter(
      (e) =>
        e.event === "agent_speaking_start" || e.event === "agent_speaking_end",
    )
    .at(-1);
  return last?.event === "agent_speaking_start";
}

async function main(): Promise<void> {
  const args = parseBenchArgs(process.argv.slice(2));
  const apiKey = process.env.VOICETHERE_CLIENT_API_KEY;
  if (!apiKey) throw new Error("set VOICETHERE_CLIENT_API_KEY (a vthc_ key)");

  await prepareOutDir(args.out);
  const frames = clipToFrames(
    decodeWav(new Uint8Array(await readFile(args.clip))),
  );
  const watch = new SuspendWatch();
  watch.start();

  const records: BenchRecord[] = [];
  const startedAt = new Date();
  let failedTurns = 0;
  for (let c = 0; c < args.conversations; c++) {
    console.log(`conversation ${c + 1}/${args.conversations}`);
    try {
      failedTurns += await runConversation(
        args,
        apiKey,
        frames,
        c * args.turns + 1,
        records,
      );
    } catch (error) {
      failedTurns += args.turns;
      console.error(
        `conversation ${c + 1} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  watch.stop();

  const meta: BenchMeta = {
    schema_version: 1,
    source: "client-latency-bench",
    concurrency: 1,
    conversations: args.conversations,
    turns_per_conversation: args.turns,
    failed_turns: failedTurns,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    host_suspended: watch.gaps,
  };
  await writeResults(args.out, {
    records,
    meta,
    environment: collectEnvironment(args.region),
  });
  console.log(
    `wrote ${records.length} records to ${args.out} (${failedTurns} failed turns)`,
  );
  if (watch.suspended) {
    console.log("[host-suspended] result: inconclusive");
    process.exitCode = 3;
  } else if (records.length === 0) {
    process.exitCode = 1;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
