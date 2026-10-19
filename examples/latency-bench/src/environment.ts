import { readFileSync } from "node:fs";
import os from "node:os";

function clientVersion(): string {
  try {
    const raw = readFileSync(
      new URL("../../../package.json", import.meta.url),
      "utf8",
    );
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Where and on what the run happened. No hostnames, addresses or user names. */
export function collectEnvironment(
  region: string | null,
): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    cpu: { model: cpus[0]?.model ?? "unknown", count: cpus.length },
    memory_total_mb: Math.round(os.totalmem() / 1024 / 1024),
    load_avg_1m_at_start: Number(os.loadavg()[0]!.toFixed(2)),
    node_version: process.version,
    voicethere_client_version: clientVersion(),
    region,
  };
}
