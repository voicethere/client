import { parseArgs } from "node:util";

export const DEFAULT_API_BASE = "https://sessions.voicethere.io/v1";

export type BenchArgs = {
  turns: number;
  conversations: number;
  out: string;
  region: string | null;
  projectId: string;
  apiBase: string;
  clip: string;
  model: string;
  turnTimeoutMs: number;
};

function positiveInt(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

/** Parses the command line. The API key is not an argument: it is read from the environment. */
export function parseBenchArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): BenchArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      turns: { type: "string", default: "10" },
      conversations: { type: "string", default: "1" },
      out: { type: "string" },
      region: { type: "string" },
      project: { type: "string" },
      "api-base": { type: "string" },
      clip: { type: "string" },
      model: { type: "string", default: "default/default" },
      "turn-timeout-ms": { type: "string", default: "30000" },
    },
    strict: true,
  });
  if (!values.out) throw new Error("--out <dir> is required");
  if (!values.clip) {
    throw new Error("--clip <file.wav> is required (a spoken counting phrase)");
  }
  const projectId = values.project ?? env.VOICETHERE_PROJECT_ID;
  if (!projectId) {
    throw new Error("pass --project <id> or set VOICETHERE_PROJECT_ID");
  }
  return {
    turns: positiveInt("turns", values.turns!),
    conversations: positiveInt("conversations", values.conversations!),
    out: values.out,
    region: values.region ?? null,
    projectId,
    apiBase: values["api-base"] ?? DEFAULT_API_BASE,
    clip: values.clip,
    model: values.model!,
    turnTimeoutMs: positiveInt("turn-timeout-ms", values["turn-timeout-ms"]!),
  };
}
