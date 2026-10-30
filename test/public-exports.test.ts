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

/** Names that must stay importable per subpath (generated from the packed build, sorted). Extra names are allowed. */
const EXPECTED_EXPORTS: Record<string, string[]> = {
  ".": [
    "ConnectionError",
    "appendJoinToken",
    "connectVoiceSession",
    "createConnectionError",
    "formatConnectionErrorSource",
    "getRootConnectionErrorHandler",
    "parseAgentInterruptedEvent",
    "parseAgentStateEvent",
    "reportConnectionError",
    "resolveConnection",
    "setRootConnectionErrorHandler",
  ],
  "./browser": [
    "BrowserSessionModeType",
    "CLIENT_CAPABILITIES",
    "CLIENT_HANGUP_MESSAGE_TYPE",
    "CONNECTION_INTERRUPTED_MESSAGE",
    "CONNECTION_LOST_MESSAGE",
    "CONNECTION_RESTORED_MESSAGE",
    "CONNECTION_SESSION_ENDED_MESSAGE",
    "ConnectionError",
    "CustomerContextTooLargeError",
    "DEFAULT_SESSION_API_RETRY_DELAYS_MS",
    "LOCAL_SESSION_ERROR_CODES",
    "MAX_CUSTOMER_CONTEXT_BYTES",
    "ProvisionedRunnerModeType",
    "REMOTE_SESSION_ERROR_CODES",
    "SESSION_ERROR_CODES",
    "VOICETHERE_CHAT_CHANNEL_LABEL",
    "VOICE_CONTROL_CHANNEL_LABEL",
    "VOICE_SYNC_CHANNEL_LABEL",
    "acquireAudioInput",
    "attachAudioVisualizer",
    "buildWebRtcConnectionStatus",
    "closePeerConnectionAwaitable",
    "collectWebRtcDiagnostics",
    "connectBrowserChatSession",
    "connectBrowserSession",
    "connectBrowserVoiceSession",
    "connectDataSession",
    "createConnectionError",
    "createDebugConsole",
    "createHiddenAudioElement",
    "createLocalSessionError",
    "createSyntheticMicStream",
    "deriveWebRtcConnectionPhase",
    "emitSessionError",
    "fetchSessionApi",
    "formatConnectionErrorSource",
    "formatIceTriageLine",
    "formatWebRtcDiagnosticsLines",
    "getDefaultBrowserRuntime",
    "getRootConnectionErrorHandler",
    "isRetryableSessionApiBody",
    "isRetryableSessionApiFailure",
    "isRetryableSessionApiNetworkError",
    "isRetryableSessionApiStatus",
    "isSessionErrorEvent",
    "isWebRtcConnectionReady",
    "listAudioInputDevices",
    "parseAgentInterruptedEvent",
    "parseAgentStateEvent",
    "peerConnectionSupportsCloseAsync",
    "redactDiagnosticDetail",
    "reportConnectionError",
    "resolveReadinessProfile",
    "setRootConnectionErrorHandler",
    "startSession",
    "stopMicStream",
    "summarizeRtcStatsReport",
    "unlockAudioPlayback",
  ],
  "./embed": [
    "DEFAULT_WIDGET_API_BASE",
    "DEFAULT_WIDGET_CDN_BASE",
    "WIDGET_BOOTSTRAP_SESSION_CACHE_MS",
    "WIDGET_CONFIG_VERSION",
    "WIDGET_CSS_CLASSES",
    "WIDGET_CSS_VARIABLES",
    "WIDGET_KEY_HASH_FIXTURE_HEX",
    "WIDGET_KEY_HASH_FIXTURE_RAW",
    "WIDGET_POSITIONS",
    "WIDGET_PRESET_IDS",
    "WidgetBootstrapError",
    "WidgetConfigError",
    "applyPreset",
    "bootstrapIdentityFromDocument",
    "createSpokenChatCaption",
    "createVoiceThereWidget",
    "createVoiceThereWidgetAsync",
    "fetchVoiceThereWidgetConfig",
    "fetchWidgetBootstrapByClientKey",
    "getWidgetPreset",
    "parseVoiceThereWidgetConfigJson",
    "parseVoiceThereWidgetConfigV1",
    "parseWidgetBootstrapDocument",
    "parseWidgetBootstrapJson",
    "resolveWidgetCdnBase",
    "sha256HexUtf8",
    "widgetBootstrapCdnUrl",
    "widgetBootstrapSessionCacheKey",
    "widgetKeyMapUrl",
    "widgetProjectBootstrapUrl",
  ],
  "./node": [
    "BrowserSessionModeType",
    "CLIENT_CAPABILITIES",
    "CustomerContextTooLargeError",
    "DEFAULT_SESSION_API_RETRY_DELAYS_MS",
    "MAX_CUSTOMER_CONTEXT_BYTES",
    "NodeWebSocketAdapter",
    "ProvisionedRunnerModeType",
    "VOICE_CONTROL_CHANNEL_LABEL",
    "VOICE_SYNC_CHANNEL_LABEL",
    "collectWebRtcDiagnostics",
    "connectBrowserChatSession",
    "connectBrowserSession",
    "connectBrowserVoiceSession",
    "connectDataSession",
    "createNodeWebRtcRuntime",
    "fetchSessionApi",
    "formatIceTriageLine",
    "formatWebRtcDiagnosticsLines",
    "isRetryableSessionApiBody",
    "isRetryableSessionApiFailure",
    "isRetryableSessionApiNetworkError",
    "isRetryableSessionApiStatus",
    "startSession",
    "summarizeRtcStatsReport",
  ],
};

/** Exported from a module but deliberately not part of any public subpath. name -> reason. */
const INTERNAL: Record<string, string> = {
  parseLegacyAgentError: "used by browser-voice-session.ts",
  emitDiagnosticSafely: "used by browser-voice-session.ts",
  isWebRtcConnectRetryError: "used by browser-voice-session.ts",
  isHalfOpenConnection: "used by browser-voice-session.ts",
  resolveHalfOpenFailFastMs: "used by browser-voice-session.ts",
  formatWebRtcConnectTimeoutMessage: "used by browser-voice-session.ts",
  preferOpusStereoInAnswer: "used by browser-voice-session.ts",
  waitForIceGatheringComplete: "used by browser-voice-session.ts",
  mapProvisioningFailureCode:
    "used by session-provision.ts and session-provision-poll.ts",
  dispatchConnectionError:
    "used by browser-voice-session.ts and node-websocket.ts",
  SYNTHETIC_MIC_NOISE_GAIN:
    "used inside microphone.ts (mic constraints and synthetic mic)",
  buildAudioConstraints:
    "used inside microphone.ts (mic constraints and synthetic mic)",
  getStreamDeviceId: "unused inside the package; candidate for removal",
  isTerminalSessionJobStatus:
    "unused inside the package; candidate for removal",
  isCapacityWaitStatus: "unused inside the package; candidate for removal",
  resolvePostSessions429FailureCode:
    "used inside session-provision.ts for 429 handling",
  diagnosticErrorCode: "used inside voice-session-diagnostics.ts",
  DEFAULT_HALF_OPEN_FAIL_FAST_MS: "used inside webrtc-connection-status.ts",
  usesHalfOpenFailFast: "used inside webrtc-connection-status.ts",
  drawIdleVisualizer: "drawn by attachAudioVisualizer; not a standalone API",
  SESSION_POLL_BACKOFF_MULTIPLIERS:
    "used inside session-provision-poll.ts (status polling backoff)",
  SESSION_POLL_INTERVAL_CAP_MS:
    "used inside session-provision-poll.ts (status polling backoff)",
  SESSION_POLL_RETRY_AFTER_MIN_MS:
    "used inside session-provision-poll.ts (status polling backoff)",
  SESSION_POLL_RETRY_AFTER_MAX_MS:
    "used inside session-provision-poll.ts (status polling backoff)",
  defaultSessionPollRuntime:
    "used inside session-provision-poll.ts (status polling backoff)",
  clampSessionPollRetryAfterMs:
    "used inside session-provision-poll.ts (status polling backoff)",
  shouldResetSessionPollBackoff:
    "used inside session-provision-poll.ts (status polling backoff)",
  computeSessionPollDelayMs:
    "used inside session-provision-poll.ts (status polling backoff)",
  pollSessionStatus: "used by session-provision.ts",
  remoteOfferHasIceUfrag: "used inside browser-voice-session.ts",
  toSessionDescriptionInit: "used inside browser-voice-session.ts",
  DEFAULT_RECONNECT_BUDGET_MS: "used inside browser-voice-session.ts",
  DEFAULT_REJOIN_AFTER_DISCONNECTED_MS: "used inside browser-voice-session.ts",
  RECONNECT_INFLIGHT_GRACE_MS: "used inside browser-voice-session.ts",
  VOICE_AGENT_SERVER_PEER_ID: "used inside browser-voice-session.ts",
  WIDGET_CUSTOM_STYLE_ATTR: "used by embed/index.ts (widget internals)",
  applyWidgetPosition: "used by embed/index.ts (widget internals)",
  widgetConfigModeToSessionMode: "used by embed/index.ts (widget internals)",
  clearWidgetKeyPointer: "used by embed/index.ts (widget internals)",
  STAGING_WIDGET_CDN_BASE:
    "used inside embed/hosts.ts (staging host resolution)",
  isValidWidgetPublicId: "used by embed/bootstrap.ts",
  resolveWidgetTheme: "used inside embed/presets.ts",
  isWidgetPresetId: "used inside embed/config.ts validation",
  isValidCssLength: "used inside embed/config.ts validation",
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

  it("all modules are re-exported", () => {
    const entries = new Set([
      "index.ts",
      "browser/browser-session.ts",
      "node/index.ts",
      "embed/index.ts",
    ]);
    const allRuntime = new Set(Object.values(keysBySub).flat());
    const missing: string[] = [];
    for (const rel of ["", "browser", "node", "embed"]) {
      const dir = join(ROOT, "src", rel);
      for (const f of readdirSync(dir)) {
        const relFile = rel ? `${rel}/${f}` : f;
        if (
          !f.endsWith(".ts") ||
          f.endsWith(".test.ts") ||
          entries.has(relFile)
        )
          continue;
        const src = readFileSync(join(dir, f), "utf8");
        for (const m of src.matchAll(
          /^export (?:async )?function (\w+)|^export const (\w+)/gm,
        )) {
          const name = (m[1] ?? m[2])!;
          if (!allRuntime.has(name) && !(name in INTERNAL))
            missing.push(`${f}: ${name}`);
        }
      }
    }
    expect(
      missing,
      "not re-exported from any subpath and not in INTERNAL",
    ).toEqual([]);
    expect(
      Object.keys(INTERNAL).filter((n) => allRuntime.has(n)),
      "allowlisted but public",
    ).toEqual([]);
  });
});
