import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { computeTurnMetrics } from "./metrics.js";
import {
  RECORD_KEYS,
  buildRecord,
  phaseFor,
  prepareOutDir,
  writeResults,
  type BenchMeta,
} from "./records.js";
import { collectEnvironment } from "./environment.js";
import { parseBenchArgs } from "./args.js";

const meta: BenchMeta = {
  schema_version: 1,
  source: "client-latency-bench",
  concurrency: 1,
  conversations: 1,
  turns_per_conversation: 2,
  failed_turns: 0,
  started_at: "2026-10-20T10:00:00.000Z",
  finished_at: "2026-10-20T10:01:00.000Z",
  host_suspended: [],
};

describe("records", () => {
  it("first turn of a conversation is cold, later turns are warm", () => {
    expect([0, 1, 2].map(phaseFor)).toEqual(["cold", "warm", "warm"]);
  });

  it("record keys match the nwr BenchRecord field order", () => {
    // Mirrors `BenchRecord` in node-webrtc-rust crates/vendor-live-support/src/bench.rs.
    const record = buildRecord({
      model: "default/default",
      turnIndexInConversation: 0,
      run: 1,
      metrics: computeTurnMetrics({ speechEndAtMs: 0, events: [] }),
    });
    expect(Object.keys(record)).toEqual([...RECORD_KEYS]);
    expect(RECORD_KEYS).toEqual([
      "vendor",
      "leg",
      "transport",
      "model",
      "phase",
      "text",
      "run",
      "http_version",
      "metrics",
    ]);
    expect(Object.keys(record.metrics)).toEqual([
      "speech_end_to_final_ms",
      "final_to_reply_start_ms",
      "speech_end_to_reply_start_ms",
      "tts_first_audio_ms",
    ]);
  });

  it("writes no transcript, session id or key into any output file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latency-bench-"));
    const transcript = "one two three four";
    const metrics = computeTurnMetrics({
      speechEndAtMs: 0,
      events: [
        { event: "user_speech_final", atMs: 10, text: transcript },
        {
          event: "agent_speaking_start",
          atMs: 30,
          payload: { firstAudioMs: 7, sessionId: "sess-123" },
        },
      ],
    });
    await prepareOutDir(dir);
    await writeResults(dir, {
      records: [
        buildRecord({
          model: "default/default",
          turnIndexInConversation: 0,
          run: 1,
          metrics,
        }),
      ],
      meta,
      environment: collectEnvironment("eu-test"),
    });
    for (const file of ["raw.jsonl", "meta.json", "environment.json"]) {
      const text = await readFile(join(dir, file), "utf8");
      expect(text).not.toContain("one two");
      expect(text).not.toContain("sess-123");
      expect(text).not.toMatch(/vthc_|Bearer/);
    }
    const line = JSON.parse(
      (await readFile(join(dir, "raw.jsonl"), "utf8")).trim(),
    );
    expect(line.metrics.speech_end_to_reply_start_ms).toBe(30);
  });

  it("refuses to overwrite an existing raw.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latency-bench-"));
    await writeFile(join(dir, "raw.jsonl"), "keep\n");
    await expect(prepareOutDir(dir)).rejects.toThrow(/already exists/);
    await expect(
      writeResults(dir, { records: [], meta, environment: {} }),
    ).rejects.toThrow();
    expect(await readFile(join(dir, "raw.jsonl"), "utf8")).toBe("keep\n");
  });
});

describe("parseBenchArgs", () => {
  it("applies defaults and reads the project from the environment", () => {
    const args = parseBenchArgs(["--out", "o", "--clip", "c.wav"], {
      VOICETHERE_PROJECT_ID: "p",
    });
    expect(args).toMatchObject({ turns: 10, conversations: 1, projectId: "p" });
  });

  it("requires --out, --clip and a project", () => {
    expect(() =>
      parseBenchArgs(["--clip", "c"], { VOICETHERE_PROJECT_ID: "p" }),
    ).toThrow(/--out/);
    expect(() =>
      parseBenchArgs(["--out", "o"], { VOICETHERE_PROJECT_ID: "p" }),
    ).toThrow(/--clip/);
    expect(() => parseBenchArgs(["--out", "o", "--clip", "c"], {})).toThrow(
      /project/,
    );
  });
});
