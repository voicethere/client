import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, unknown>;
};

/** Names that must stay importable per subpath. Extra names are allowed. */
const EXPECTED_EXPORTS: Record<string, string[]> = {
  ".": [],
  "./browser": [],
  "./embed": [
    "createVoiceThereWidget",
    "createVoiceThereWidgetAsync",
    "createSpokenChatCaption",
    "fetchVoiceThereWidgetConfig",
    "parseVoiceThereWidgetConfigV1",
    "parseVoiceThereWidgetConfigJson",
    "WidgetConfigError",
    "WIDGET_CONFIG_VERSION",
    "WIDGET_POSITIONS",
    "WIDGET_PRESET_IDS",
    "applyPreset",
    "getWidgetPreset",
    "WIDGET_CSS_CLASSES",
    "WIDGET_CSS_VARIABLES",
    "bootstrapIdentityFromDocument",
    "fetchWidgetBootstrapByClientKey",
    "parseWidgetBootstrapDocument",
    "parseWidgetBootstrapJson",
    "WidgetBootstrapError",
    "WIDGET_BOOTSTRAP_SESSION_CACHE_MS",
    "widgetBootstrapSessionCacheKey",
    "DEFAULT_WIDGET_API_BASE",
    "DEFAULT_WIDGET_CDN_BASE",
    "resolveWidgetCdnBase",
    "widgetBootstrapCdnUrl",
    "widgetKeyMapUrl",
    "widgetProjectBootstrapUrl",
    "sha256HexUtf8",
  ],
  "./node": [],
};

/** Exported from an embed module but deliberately not part of the public surface. */
const EMBED_INTERNAL: Record<string, string> = {
  clearWidgetKeyPointer: "widget-internal cache cleanup",
  isWidgetPresetId: "widget-internal config validation helper",
  isValidCssLength: "widget-internal config validation helper",
  widgetConfigModeToSessionMode: "widget-internal mode mapping",
  resolveWidgetTheme: "widget-internal theme resolution",
  applyWidgetPosition: "widget-internal DOM positioning",
  WIDGET_CUSTOM_STYLE_ATTR: "widget-internal DOM attribute name",
  isValidWidgetPublicId: "widget-internal id check",
  STAGING_WIDGET_CDN_BASE: "internal staging host",
  WIDGET_KEY_HASH_FIXTURE_RAW: "test fixture",
  WIDGET_KEY_HASH_FIXTURE_HEX: "test fixture",
};

let tmp = "";
const keysBySub: Record<string, string[]> = {};

function specFor(sub: string): string {
  return sub === "." ? pkg.name : `${pkg.name}/${sub.slice(2)}`;
}

function loadInTmp(spec: string): string[] {
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(spec)}); console.log(JSON.stringify(Object.keys(m)));`,
    ],
    { cwd: tmp, encoding: "utf8" },
  );
  return JSON.parse(out.trim().split("\n").pop() as string) as string[];
}

describe("packed public surface", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });
    tmp = mkdtempSync(join(tmpdir(), "vt-client-pack-"));
    const packDir = join(tmp, "pack");
    mkdirSync(packDir);
    const packOut = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", packDir],
      { cwd: ROOT, encoding: "utf8" },
    );
    const filename = (JSON.parse(packOut) as { filename: string }[])[0]!
      .filename;
    const consumer = join(tmp, "consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    execFileSync(
      "npm",
      ["install", "--no-save", "--ignore-scripts", join(packDir, filename)],
      { cwd: consumer, stdio: "pipe" },
    );
    tmp = consumer;
    for (const sub of Object.keys(pkg.exports)) {
      try {
        keysBySub[sub] = loadInTmp(specFor(sub));
      } catch (e) {
        keysBySub[sub] = [`__import_failed__:${String(e)}`];
      }
    }
  }, 600_000);

  it("every exports subpath resolves", () => {
    for (const sub of Object.keys(pkg.exports)) {
      const keys = keysBySub[sub] ?? [];
      expect(
        keys.some((k) => k.startsWith("__import_failed__")),
        `${specFor(sub)} failed to import: ${keys[0]}`,
      ).toBe(false);
    }
  });

  it("embed exposes createSpokenChatCaption", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(`${pkg.name}/embed`)});
const c = m.createSpokenChatCaption({ enabled: true, onUpsert() {} });
console.log(JSON.stringify({ t: typeof m.createSpokenChatCaption, h: typeof c.handleControlMessage, s: typeof c.setEnabled, d: typeof c.dispose }));
c.dispose();`,
      ],
      { cwd: tmp, encoding: "utf8" },
    );
    expect(JSON.parse(out.trim().split("\n").pop() as string)).toEqual({
      t: "function",
      h: "function",
      s: "function",
      d: "function",
    });
  });

  it("expected public names", () => {
    expect(Object.keys(EXPECTED_EXPORTS).sort()).toEqual(
      Object.keys(pkg.exports).sort(),
    );
    for (const [sub, names] of Object.entries(EXPECTED_EXPORTS)) {
      for (const name of names) {
        expect(
          keysBySub[sub] ?? [],
          `${specFor(sub)} is missing export ${name}`,
        ).toContain(name);
      }
    }
  });

  it("embed modules are re-exported", () => {
    const dir = join(ROOT, "src", "embed");
    const runtime = new Set(keysBySub["./embed"] ?? []);
    const missing: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "index.ts")
        continue;
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(
        /^export (?:async )?function (\w+)|^export const (\w+)/gm,
      )) {
        const name = (m[1] ?? m[2])!;
        if (!runtime.has(name) && !(name in EMBED_INTERNAL)) {
          missing.push(`${f}: ${name}`);
        }
      }
    }
    expect(
      missing,
      `not re-exported from ${pkg.name}/embed and not in EMBED_INTERNAL`,
    ).toEqual([]);
  });
});
