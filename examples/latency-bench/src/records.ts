import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TurnMetricValues } from "./metrics.js";

/**
 * Key order of one `raw.jsonl` line. Mirrors the `BenchRecord` struct in
 * https://github.com/akirilyuk/node-webrtc-rust (`crates/vendor-live-support/src/bench.rs`),
 * so the nwr summariser and compare tool read this file unchanged.
 */
export const RECORD_KEYS = [
  "vendor",
  "leg",
  "transport",
  "model",
  "phase",
  "text",
  "run",
  "http_version",
  "metrics",
] as const;

export type BenchRecord = {
  vendor: "voicethere";
  leg: "e2e";
  transport: "webrtc";
  model: string;
  phase: "cold" | "warm";
  text: "counting-echo";
  run: number;
  http_version: null;
  metrics: TurnMetricValues;
};

/** The first turn of a conversation is cold (new session, new connections); later turns are warm. */
export function phaseFor(turnIndexInConversation: number): "cold" | "warm" {
  return turnIndexInConversation === 0 ? "cold" : "warm";
}

export function buildRecord(input: {
  model: string;
  turnIndexInConversation: number;
  run: number;
  metrics: TurnMetricValues;
}): BenchRecord {
  return {
    vendor: "voicethere",
    leg: "e2e",
    transport: "webrtc",
    model: input.model,
    phase: phaseFor(input.turnIndexInConversation),
    text: "counting-echo",
    run: input.run,
    http_version: null,
    metrics: input.metrics,
  };
}

export type BenchMeta = {
  schema_version: 1;
  source: "client-latency-bench";
  concurrency: 1;
  conversations: number;
  turns_per_conversation: number;
  failed_turns: number;
  started_at: string;
  finished_at: string;
  host_suspended: { at: string; gap_ms: number }[];
};

export const RAW_FILE = "raw.jsonl";

/** Throws when `raw.jsonl` already exists in `dir`; creates `dir` otherwise. */
export async function prepareOutDir(dir: string): Promise<void> {
  if (existsSync(join(dir, RAW_FILE))) {
    throw new Error(
      `${join(dir, RAW_FILE)} already exists; choose a new --out directory`,
    );
  }
  await mkdir(dir, { recursive: true });
}

export async function writeResults(
  dir: string,
  results: {
    records: BenchRecord[];
    meta: BenchMeta;
    environment: Record<string, unknown>;
  },
): Promise<void> {
  const lines = results.records.map((r) => JSON.stringify(r)).join("\n");
  // "wx" fails if the file appeared since prepareOutDir: never overwrite a result.
  await writeFile(join(dir, RAW_FILE), lines ? `${lines}\n` : "", {
    flag: "wx",
  });
  await writeFile(
    join(dir, "meta.json"),
    `${JSON.stringify(results.meta, null, 2)}\n`,
  );
  await writeFile(
    join(dir, "environment.json"),
    `${JSON.stringify(results.environment, null, 2)}\n`,
  );
}
