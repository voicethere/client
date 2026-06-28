import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function readSource(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("browser dependency boundary", () => {
  it("keeps browser-facing source free of @node-webrtc-rust/sdk imports", () => {
    const paths = [
      "src/browser/browser-voice-session.ts",
      "src/browser/browser-session.ts",
      "src/session-errors.ts",
      "src/index.ts",
    ];

    for (const path of paths) {
      const source = readSource(path);
      expect(source).not.toMatch(/from\s+["']@node-webrtc-rust\/sdk(?:["']|\/)/);
      expect(source).not.toMatch(/require\(["']@node-webrtc-rust\/sdk(?:["']|\/)/);
    }
  });

  it("keeps browser export on the browser-only entrypoint", () => {
    const pkg = JSON.parse(readSource("package.json")) as {
      exports?: Record<string, { import?: string }>;
    };
    expect(pkg.exports?.["./browser"]?.import).toBe(
      "./dist/browser/browser-session.js",
    );
  });
});
