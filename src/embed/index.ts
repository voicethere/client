import {
  BrowserSessionModeType,
  connectBrowserSession,
  createDebugConsole,
  startSession,
  unlockAudioPlayback,
  type AgentContent,
  type BrowserSession,
  type BrowserSessionMode,
  type StartSessionResult,
  type WebRtcConnectionStatus,
  type WebRtcRuntime,
} from "../browser/browser-session.js";
import type { SessionErrorEvent } from "../session-errors.js";
import type { AudioInputState } from "../browser/microphone.js";
import {
  bootstrapIdentityFromDocument,
  clearWidgetKeyPointer,
  fetchWidgetBootstrapByClientKey,
  WidgetBootstrapError,
  type WidgetBootstrapIdentity,
} from "./bootstrap.js";
import {
  fetchVoiceThereWidgetConfig,
  WidgetConfigError,
  widgetConfigModeToSessionMode,
  type VoiceThereWidgetConfigV1,
  type VoiceThereWidgetTheme,
  type WidgetDisplay,
  type WidgetPosition,
  type WidgetPositionOffset,
  type WidgetPresetId,
  type WidgetTimeFormat,
  type WidgetTimestampsTheme,
} from "./config.js";
import {
  WIDGET_CSS_CLASSES,
  WIDGET_CSS_VARIABLES,
  WIDGET_CUSTOM_STYLE_ATTR,
} from "./css.js";
import {
  applyPreset,
  applyWidgetPosition,
  getWidgetPreset,
  type ResolvedWidgetTheme,
} from "./presets.js";
import type { DebugEvent } from "../browser/debug-console.js";
import { createSpokenChatCaption } from "../spoken-text-reveal.js";

export type {
  VoiceThereWidgetConfigV1,
  VoiceThereWidgetTheme,
  WidgetDisplay,
  WidgetPosition,
  WidgetPositionOffset,
  WidgetPresetId,
  WidgetTimeFormat,
  WidgetTimestampsTheme,
  StartSessionResult,
};
export {
  WidgetConfigError,
  fetchVoiceThereWidgetConfig,
  parseVoiceThereWidgetConfigJson,
  parseVoiceThereWidgetConfigV1,
  WIDGET_CONFIG_VERSION,
  WIDGET_DISPLAYS,
  WIDGET_POSITIONS,
  WIDGET_TIME_FORMATS,
  WIDGET_PRESET_IDS,
} from "./config.js";
export { applyPreset, getWidgetPreset } from "./presets.js";
export { WIDGET_CSS_CLASSES, WIDGET_CSS_VARIABLES } from "./css.js";
export {
  bootstrapIdentityFromDocument,
  fetchWidgetBootstrapByClientKey,
  parseWidgetBootstrapDocument,
  parseWidgetBootstrapJson,
  WidgetBootstrapError,
  WIDGET_BOOTSTRAP_SESSION_CACHE_MS,
  widgetBootstrapSessionCacheKey,
  type WidgetBootstrapDocumentV1,
  type WidgetBootstrapIdentity,
} from "./bootstrap.js";
export {
  DEFAULT_WIDGET_API_BASE,
  DEFAULT_WIDGET_CDN_BASE,
  resolveWidgetCdnBase,
  widgetBootstrapCdnUrl,
  widgetKeyMapUrl,
  widgetProjectBootstrapUrl,
} from "./hosts.js";
export {
  sha256HexUtf8,
  WIDGET_KEY_HASH_FIXTURE_HEX,
  WIDGET_KEY_HASH_FIXTURE_RAW,
} from "./widget-key-hash.js";
export {
  createAgentTextReveal,
  createSpokenChatCaption,
  type AgentTextReveal,
  type AgentTextUpdate,
  type SpokenChatCaption,
  type SpokenChatCaptionOptions,
  type SpokenTurnUpsertInfo,
  type SpokenTextRevealMode,
} from "../spoken-text-reveal.js";

/** The status line the widget shows, passed to {@link VoiceThereWidgetOptions.onStatus}. */
export type VoiceThereWidgetStatus = {
  text: string;
  /** A spinner is shown (connecting, waiting for capacity, reconnecting). */
  loading: boolean;
  /** Shown in the warning colour (lost connection, session error). */
  error: boolean;
};

/** Why a session ended, passed to {@link VoiceThereWidgetOptions.onSessionEnd}. */
export type VoiceThereWidgetSessionEnd = {
  reason: "closed" | "error";
  /** A `SessionErrorEvent` for session errors, the recovery state when the connection was lost. */
  error?: unknown;
};

export type { BrowserSession, WebRtcRuntime, DebugEvent };

export type VoiceThereWidgetOptions = {
  /**
   * Client API key (`vthc_…`). Required unless `startSession` is set.
   */
  clientKey?: string;
  /**
   * Programmatic only (never in CDN config): starts the session instead of the
   * `clientKey` request, for hosts that run their own session endpoint. Errors
   * (a rejected promise or `ok: false`) show in the status line.
   */
  startSession?: (signal: AbortSignal) => Promise<StartSessionResult>;
  /**
   * `"launcher"` (default): floating launcher button and panel.
   * `"inline"`: no launcher; the panel fills `mount` and is always open
   * (`open()` / `close()` do nothing).
   */
  display?: WidgetDisplay;
  projectId?: string;
  apiBase?: string;
  mode?: BrowserSessionMode;
  theme?: VoiceThereWidgetTheme;
  mount?: HTMLElement;
  preset?: WidgetPresetId;
  configUrl?: string;
  launcherLabel?: string;
  greeting?: string;
  position?: WidgetPosition;
  positionOffset?: WidgetPositionOffset;
  customCss?: string;
  streamSpokenText?: boolean;
  /**
   * Host hooks (programmatic only, never in CDN config). Each runs after the
   * widget's own handling. A hook that throws is logged with `console.warn`
   * and never breaks the widget.
   *
   * Called with the live session after each connect and after a same-session
   * reconnect, and with `null` when the session is gone.
   */
  onSession?: (session: BrowserSession | null) => void;
  /** Called once per session when it ends (disconnect, lost connection, session error, destroy). */
  onSessionEnd?: (info: VoiceThereWidgetSessionEnd) => void;
  /** The agent's audio track, after the widget has attached its own audio. */
  onAgentAudioTrack?: (track: MediaStreamTrack) => void;
  /** Read-only tap of every agent control message, after the widget rendered it. */
  onControlMessage?: (message: Record<string, unknown>) => void;
  /** Every change of the status line the widget shows. */
  onStatus?: (status: VoiceThereWidgetStatus) => void;
  /**
   * Decides which agent links (https URLs the agent sends) are clickable. A
   * link it rejects, or a call that throws (logged with `console.warn`), is
   * shown as plain text with the link icon. Absent: every https link is
   * clickable.
   */
  isLinkAllowed?: (url: URL) => boolean;
  /**
   * Every debug event the widget's session pipeline emits (session start,
   * signaling, WebRTC), in addition to the widget's own handling. A hook that
   * throws is logged with `console.warn` and never breaks the session.
   */
  onDebugEvent?: (event: DebugEvent) => void;
  /**
   * Microphone options for voice sessions. `deviceId` is the preferred input
   * (`deviceId: { ideal }` for getUserMedia); `silent` sends a silent track
   * and never asks for the microphone.
   */
  audio?: { deviceId?: string; silent?: boolean };
  /** Injectable WebRTC runtime (default: browser globals), for host tests. */
  runtime?: WebRtcRuntime;
};

export type VoiceThereWidget = {
  open: () => void;
  close: () => void;
  destroy: () => void;
  updateConfig: (partial: Partial<VoiceThereWidgetConfigV1>) => void;
};

type ResolvedVoiceThereWidgetOptions = {
  projectId: string;
  apiBase: string;
  clientKey?: string;
  startSession?: (signal: AbortSignal) => Promise<StartSessionResult>;
  display: WidgetDisplay;
  mode: BrowserSessionMode;
  theme?: VoiceThereWidgetTheme;
  mount?: HTMLElement;
  preset: WidgetPresetId;
  launcherLabel: string;
  greeting?: string;
  position: WidgetPosition;
  positionOffset?: WidgetPositionOffset;
  customCss?: string;
  /** Spoken `assistant_*` text is paced (any value but `false`). */
  streamSpokenText: boolean;
  /** Plain `chat_reply` is paced too (only an explicit `true`). */
  paceChatReply: boolean;
  onSession?: VoiceThereWidgetOptions["onSession"];
  onSessionEnd?: VoiceThereWidgetOptions["onSessionEnd"];
  onAgentAudioTrack?: VoiceThereWidgetOptions["onAgentAudioTrack"];
  onControlMessage?: VoiceThereWidgetOptions["onControlMessage"];
  onStatus?: VoiceThereWidgetOptions["onStatus"];
  isLinkAllowed?: VoiceThereWidgetOptions["isLinkAllowed"];
  onDebugEvent?: VoiceThereWidgetOptions["onDebugEvent"];
  audio?: VoiceThereWidgetOptions["audio"];
  runtime?: VoiceThereWidgetOptions["runtime"];
};

/** Run a host hook after the widget's own handling; a throw never breaks the widget. */
function callHost<A extends unknown[]>(
  hook: ((...args: A) => void) | undefined,
  ...args: A
): void {
  if (!hook) return;
  try {
    hook(...args);
  } catch (error) {
    console.warn("VoiceThere widget: host callback threw", error);
  }
}

function mergeWidgetOptions(
  inline: VoiceThereWidgetOptions,
  remote?: VoiceThereWidgetConfigV1,
  bootstrap?: WidgetBootstrapIdentity,
): ResolvedVoiceThereWidgetOptions {
  const projectId =
    inline.projectId ?? bootstrap?.projectId ?? remote?.projectId;
  const apiBase = inline.apiBase ?? bootstrap?.apiBase ?? remote?.apiBase;
  if (!inline.startSession) {
    if (!inline.clientKey) {
      throw new Error(
        "VoiceThere widget requires clientKey or a startSession provider",
      );
    }
    if (!projectId) {
      throw new Error(
        "VoiceThere widget requires projectId (inline, CDN bootstrap, or configUrl)",
      );
    }
    if (!apiBase) {
      throw new Error(
        "VoiceThere widget requires apiBase (inline, CDN bootstrap, or configUrl)",
      );
    }
  }

  const mode =
    inline.mode ??
    widgetConfigModeToSessionMode(remote?.mode) ??
    BrowserSessionModeType.Chat;

  return {
    projectId: projectId ?? "",
    apiBase: apiBase ?? "",
    clientKey: inline.clientKey,
    startSession: inline.startSession,
    display: inline.display ?? remote?.display ?? "launcher",
    mode,
    theme: inline.theme ?? remote?.theme,
    mount: inline.mount,
    preset: inline.preset ?? remote?.preset ?? "pill-dark",
    launcherLabel: inline.launcherLabel ?? remote?.launcherLabel ?? "Chat",
    greeting: inline.greeting ?? remote?.greeting,
    position: inline.position ?? remote?.position ?? "bottom-right",
    positionOffset: inline.positionOffset ?? remote?.positionOffset,
    customCss: inline.customCss ?? remote?.customCss,
    streamSpokenText:
      (inline.streamSpokenText ?? remote?.streamSpokenText) !== false,
    paceChatReply:
      (inline.streamSpokenText ?? remote?.streamSpokenText) === true,
    onSession: inline.onSession,
    onSessionEnd: inline.onSessionEnd,
    onAgentAudioTrack: inline.onAgentAudioTrack,
    onControlMessage: inline.onControlMessage,
    onStatus: inline.onStatus,
    isLinkAllowed: inline.isLinkAllowed,
    onDebugEvent: inline.onDebugEvent,
    audio: inline.audio,
    runtime: inline.runtime,
  };
}

export async function createVoiceThereWidgetAsync(
  options: VoiceThereWidgetOptions,
): Promise<VoiceThereWidget> {
  if (options.configUrl) {
    let remote: VoiceThereWidgetConfigV1 | undefined;
    try {
      remote = await fetchVoiceThereWidgetConfig(options.configUrl);
    } catch (error) {
      const detail =
        error instanceof WidgetConfigError || error instanceof Error
          ? error.message
          : String(error);
      console.warn(
        `VoiceThere widget: CDN config unavailable (${options.configUrl}): ${detail}`,
      );
      remote = undefined;
    }
    return buildVoiceThereWidget(mergeWidgetOptions(options, remote));
  }

  let bootstrapIdentity: WidgetBootstrapIdentity | undefined;
  let appearance: VoiceThereWidgetConfigV1 | undefined;
  if (!options.clientKey) {
    // A session provider without a key has no CDN bootstrap to fetch.
    return buildVoiceThereWidget(mergeWidgetOptions(options));
  }
  try {
    const bootstrap = await fetchWidgetBootstrapByClientKey({
      clientKey: options.clientKey,
      apiBase: options.apiBase,
    });
    bootstrapIdentity = bootstrapIdentityFromDocument(bootstrap);
    appearance = bootstrap.widget ?? undefined;
  } catch (error) {
    const detail =
      error instanceof WidgetBootstrapError || error instanceof Error
        ? error.message
        : String(error);
    console.warn(`VoiceThere widget: CDN bootstrap unavailable: ${detail}`);
    bootstrapIdentity = undefined;
    appearance = undefined;
  }

  return buildVoiceThereWidget(
    mergeWidgetOptions(options, appearance, bootstrapIdentity),
  );
}

export function createVoiceThereWidget(
  options: VoiceThereWidgetOptions,
): VoiceThereWidget {
  if (options.configUrl) {
    throw new Error(
      "configUrl requires createVoiceThereWidgetAsync(); fetch CDN config before mounting",
    );
  }
  return buildVoiceThereWidget(mergeWidgetOptions(options));
}

function formatWebRtcStatus(status: WebRtcConnectionStatus): string {
  if (status.ready) return "Connected";
  switch (status.phase) {
    case "signaling":
      return "Joining signaling…";
    case "negotiating":
      return "Negotiating WebRTC…";
    case "connecting":
      return "Connecting WebRTC…";
    case "awaiting_media":
      return "Waiting for audio tracks…";
    case "awaiting_channels":
      return "Opening data channels…";
    case "failed":
      return "WebRTC connection failed";
    case "closed":
      return "Disconnected";
    default:
      return "Connecting…";
  }
}

function isMicLimitedState(state: AudioInputState): boolean {
  return state === "denied" || state === "unavailable" || state === "synthetic";
}

function isVoiceSessionMode(mode: BrowserSessionMode): boolean {
  return (
    mode === BrowserSessionModeType.Voice ||
    mode === BrowserSessionModeType.VoiceAndData
  );
}

function applyAccentTheme(
  elements: HTMLElement[],
  theme: ResolvedWidgetTheme,
): void {
  for (const el of elements) {
    el.style.background = theme.primary;
    el.style.color = theme.text;
  }
}

function applyWidgetCssVariables(
  root: HTMLElement,
  resolved: ResolvedWidgetTheme,
  theme?: VoiceThereWidgetTheme,
  presetId?: WidgetPresetId,
): void {
  const preset = presetId ? getWidgetPreset(presetId) : undefined;
  const chat = theme?.chat;
  const incoming = chat?.incoming;
  const outgoing = chat?.outgoing;

  root.style.setProperty("--vt-color-primary", resolved.primary);
  root.style.setProperty("--vt-color-bg", resolved.background);
  root.style.setProperty("--vt-color-text", resolved.text);
  root.style.setProperty(
    "--vt-font-ui",
    theme?.fontFamily ?? "system-ui, sans-serif",
  );
  root.style.setProperty("--vt-font-size-ui", theme?.fontSize ?? "14px");
  root.style.setProperty(
    "--vt-font-incoming",
    incoming?.fontFamily ?? theme?.fontFamily ?? "inherit",
  );
  root.style.setProperty(
    "--vt-font-outgoing",
    outgoing?.fontFamily ?? theme?.fontFamily ?? "inherit",
  );
  root.style.setProperty(
    "--vt-font-size-incoming",
    incoming?.fontSize ?? "13px",
  );
  root.style.setProperty(
    "--vt-font-size-outgoing",
    outgoing?.fontSize ?? "13px",
  );
  root.style.setProperty(
    "--vt-bubble-incoming-bg",
    incoming?.bubble ?? "rgba(255,255,255,0.08)",
  );
  root.style.setProperty(
    "--vt-bubble-incoming-fg",
    incoming?.color ?? resolved.text,
  );
  root.style.setProperty(
    "--vt-bubble-outgoing-bg",
    outgoing?.bubble ?? resolved.primary,
  );
  root.style.setProperty(
    "--vt-bubble-outgoing-fg",
    outgoing?.color ?? resolved.text,
  );
  root.style.setProperty(
    "--vt-header-bg",
    chat?.headerBackground ?? resolved.background,
  );
  root.style.setProperty("--vt-input-bg", chat?.inputBackground ?? "#111827");
  root.style.setProperty("--vt-input-fg", chat?.inputColor ?? resolved.text);
  root.style.setProperty(
    "--vt-panel-width",
    chat?.panelWidth ?? preset?.panelWidth ?? "320px",
  );
  root.style.setProperty(
    "--vt-panel-height",
    chat?.panelHeight ?? preset?.panelHeight ?? "420px",
  );
  root.style.setProperty(
    "--vt-panel-radius",
    chat?.panelRadius ?? preset?.panelBorderRadius ?? "12px",
  );

  root.style.fontFamily = `var(--vt-font-ui)`;
  root.style.fontSize = `var(--vt-font-size-ui)`;
}

function syncCustomCssStyle(
  root: HTMLElement,
  customCss?: string,
): HTMLStyleElement | null {
  let style = root.querySelector<HTMLStyleElement>(
    `style[${WIDGET_CUSTOM_STYLE_ATTR}]`,
  );
  if (!customCss?.trim()) {
    style?.remove();
    return null;
  }
  if (!style) {
    style = document.createElement("style");
    style.setAttribute(WIDGET_CUSTOM_STYLE_ATTR, "");
    root.append(style);
  }
  style.textContent = customCss;
  return style;
}

type TranscriptRole = "incoming" | "outgoing" | "system";

/** `data-voicethere-kind` values; tests and host pages key off these. */
export type TranscriptBubbleKind =
  "reply" | "filler" | "link" | "speech" | "chat" | "greeting";

/** The text node holder of a bubble, so updating text keeps its `<time>`. */
const bubbleTextElement = new WeakMap<HTMLElement, HTMLElement>();

const LINK_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

/**
 * Formats a message time. `auto` follows the locale; `12h` and `24h` force the
 * hour cycle. `locale` is for tests; the widget passes none (browser locale).
 */
export function formatWidgetTime(
  at: Date,
  format: WidgetTimeFormat = "auto",
  locale?: string,
): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: format === "24h" ? "2-digit" : "numeric",
    minute: "2-digit",
  };
  if (format === "12h") options.hourCycle = "h12";
  if (format === "24h") options.hourCycle = "h23";
  return new Intl.DateTimeFormat(locale, options).format(at);
}

/** Default link label: host plus path, without a bare trailing slash. */
function linkLabelFromUrl(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.host}${path}`;
}

function setBubbleText(bubble: HTMLElement, text: string): void {
  const textEl = bubbleTextElement.get(bubble);
  if (textEl) textEl.textContent = text;
  else bubble.textContent = text;
}

function createTranscriptBubbleElement(
  role: TranscriptRole,
  text: string,
): HTMLDivElement {
  const bubble = document.createElement("div");
  bubble.className = WIDGET_CSS_CLASSES.msg;
  if (role === "incoming") {
    bubble.classList.add(WIDGET_CSS_CLASSES.msgIncoming);
    bubble.style.fontFamily = "var(--vt-font-incoming)";
    bubble.style.fontSize = "var(--vt-font-size-incoming)";
    bubble.style.background = "var(--vt-bubble-incoming-bg)";
    bubble.style.color = "var(--vt-bubble-incoming-fg)";
    bubble.style.alignSelf = "flex-start";
  } else if (role === "outgoing") {
    bubble.classList.add(WIDGET_CSS_CLASSES.msgOutgoing);
    bubble.style.fontFamily = "var(--vt-font-outgoing)";
    bubble.style.fontSize = "var(--vt-font-size-outgoing)";
    bubble.style.background = "var(--vt-bubble-outgoing-bg)";
    bubble.style.color = "var(--vt-bubble-outgoing-fg)";
    bubble.style.alignSelf = "flex-end";
  } else {
    bubble.classList.add(WIDGET_CSS_CLASSES.msgSystem);
    bubble.style.fontFamily = "var(--vt-font-incoming)";
    bubble.style.fontSize = "var(--vt-font-size-incoming)";
    bubble.style.opacity = "0.85";
    bubble.style.alignSelf = "center";
  }
  bubble.style.maxWidth = "85%";
  bubble.style.padding = "8px 10px";
  bubble.style.borderRadius = "10px";
  bubble.style.lineHeight = "1.4";
  bubble.style.wordBreak = "break-word";
  bubble.setAttribute("data-voicethere-role", role);
  if (role === "system") {
    bubble.textContent = text;
  } else {
    const textEl = document.createElement("span");
    textEl.className = WIDGET_CSS_CLASSES.msgText;
    textEl.style.display = "block";
    textEl.textContent = text;
    bubble.append(textEl);
    bubbleTextElement.set(bubble, textEl);
  }
  return bubble;
}

function incomingTextFromControlMessage(
  payload: Record<string, unknown>,
): string | null {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (
    type === "session_error" ||
    type === "agent_error" ||
    type === "session_close" ||
    type === "session_reconnect_token"
  ) {
    return null;
  }

  if (type === "speech_event") {
    const event = typeof payload.event === "string" ? payload.event : "";
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) return null;
    if (event.includes("final") || event.includes("agent")) {
      return text;
    }
    return null;
  }

  if (type === "chat_reply") {
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    return text || null;
  }

  if (type === "chat_broadcast") {
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    return text || null;
  }

  if (type === "chat") {
    const role = typeof payload.role === "string" ? payload.role : "";
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) return null;
    if (role === "agent" || role === "assistant") {
      return text;
    }
    return null;
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (
    text &&
    (type === "agent_message" || type === "message" || type === "assistant")
  ) {
    return text;
  }

  return null;
}

/** Which bubble kind a control message becomes (`data-voicethere-kind`). */
function controlMessageKind(
  payload: Record<string, unknown>,
): TranscriptBubbleKind {
  if (payload.type === "speech_event") {
    const event = typeof payload.event === "string" ? payload.event : "";
    return event.includes("agent") ? "reply" : "speech";
  }
  return "reply";
}

function buildVoiceThereWidget(
  initialOptions: ResolvedVoiceThereWidgetOptions,
): VoiceThereWidget {
  const runtime: ResolvedVoiceThereWidgetOptions = { ...initialOptions };
  const mount = runtime.mount ?? document.body;
  const mode = runtime.mode;

  const root = document.createElement("div");
  root.className = WIDGET_CSS_CLASSES.root;
  root.setAttribute("data-voicethere-display", runtime.display);
  root.style.position = runtime.display === "inline" ? "relative" : "fixed";
  root.style.zIndex = "99999";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.alignItems = "flex-end";
  root.style.gap = "8px";

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = WIDGET_CSS_CLASSES.launcher;
  launcher.textContent = runtime.launcherLabel;
  launcher.style.border = "none";
  launcher.style.cursor = "pointer";

  const panel = document.createElement("div");
  panel.className = WIDGET_CSS_CLASSES.panel;
  panel.style.display = "none";
  panel.style.boxSizing = "border-box";
  panel.style.flexDirection = "column";

  const header = document.createElement("div");
  header.className = WIDGET_CSS_CLASSES.header;
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.justifyContent = "space-between";
  header.style.marginBottom = "8px";
  header.style.padding = "4px 0";
  header.style.background = "var(--vt-header-bg)";

  const headerTitle = document.createElement("span");
  headerTitle.textContent = runtime.launcherLabel;
  headerTitle.style.fontWeight = "600";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = WIDGET_CSS_CLASSES.close;
  closeBtn.setAttribute("aria-label", "Close chat");
  closeBtn.textContent = "×";
  closeBtn.style.border = "none";
  closeBtn.style.background = "transparent";
  closeBtn.style.cursor = "pointer";
  closeBtn.style.fontSize = "20px";
  closeBtn.style.lineHeight = "1";
  closeBtn.style.color = "inherit";
  header.append(headerTitle, closeBtn);

  const greeting = document.createElement("div");
  greeting.className = WIDGET_CSS_CLASSES.greeting;
  greeting.setAttribute("data-voicethere-greeting", "");
  greeting.style.display = "none";
  greeting.textContent = runtime.greeting ?? "";

  const status = document.createElement("div");
  status.className = WIDGET_CSS_CLASSES.status;
  status.style.fontSize = "12px";
  status.style.marginBottom = "8px";
  status.style.display = "flex";
  status.style.alignItems = "center";
  status.style.gap = "8px";
  status.textContent = "Disconnected";

  const statusSpinner = document.createElement("span");
  statusSpinner.style.display = "none";
  statusSpinner.style.width = "14px";
  statusSpinner.style.height = "14px";
  statusSpinner.style.border = "2px solid rgba(34, 211, 238, 0.3)";
  statusSpinner.style.borderTopColor = "#22d3ee";
  statusSpinner.style.borderRadius = "50%";
  statusSpinner.style.animation = "voicethere-spin 0.8s linear infinite";
  statusSpinner.setAttribute("aria-hidden", "true");

  const statusText = document.createElement("span");
  status.append(statusSpinner, statusText);

  if (!document.getElementById("voicethere-widget-spin-style")) {
    const style = document.createElement("style");
    style.id = "voicethere-widget-spin-style";
    style.textContent =
      "@keyframes voicethere-spin { to { transform: rotate(360deg); } }";
    document.head.append(style);
  }

  const setStatusDisplay = (text: string, loading = false, isError = false) => {
    statusText.textContent = text;
    statusSpinner.style.display = loading ? "inline-block" : "none";
    // Same amber as the mic / playback warnings.
    statusText.style.color = isError ? "#fcd34d" : "";
    callHost(runtime.onStatus, { text, loading, error: isError });
  };
  let lastRecoveryState: string | undefined;
  let restoredNoticeUntilMs = 0;

  const inboundAudio = document.createElement("audio");
  inboundAudio.autoplay = true;
  inboundAudio.setAttribute("playsinline", "");
  inboundAudio.style.display = "none";

  const micWarning = document.createElement("div");
  micWarning.className = WIDGET_CSS_CLASSES.micWarning;
  micWarning.setAttribute("data-voicethere-mic-warning", "");
  micWarning.style.display = "none";
  micWarning.style.fontSize = "11px";
  micWarning.style.lineHeight = "1.4";
  micWarning.style.marginBottom = "8px";
  micWarning.style.padding = "8px";
  micWarning.style.borderRadius = "8px";
  micWarning.style.background = "rgba(245, 158, 11, 0.15)";
  micWarning.style.border = "1px solid rgba(245, 158, 11, 0.35)";
  micWarning.style.color = "#fcd34d";
  micWarning.textContent =
    "Microphone permission was denied or unavailable (nested iframes / in-app browsers often hide the prompt). Session is connected. You can still hear the agent if the browser allows playback. Grant microphone access to speak.";

  const micRequestBtn = document.createElement("button");
  micRequestBtn.setAttribute("data-voicethere-mic-request", "");
  micRequestBtn.type = "button";
  micRequestBtn.textContent = "Request microphone";
  micRequestBtn.style.marginTop = "6px";
  micRequestBtn.style.padding = "6px 10px";
  micRequestBtn.style.borderRadius = "6px";
  micRequestBtn.style.border = "none";
  micRequestBtn.style.cursor = "pointer";
  micRequestBtn.style.fontSize = "11px";
  micWarning.append(micRequestBtn);

  const playbackWarning = document.createElement("div");
  playbackWarning.className = WIDGET_CSS_CLASSES.playbackWarning;
  playbackWarning.setAttribute("data-voicethere-playback-warning", "");
  playbackWarning.style.display = "none";
  playbackWarning.style.fontSize = "11px";
  playbackWarning.style.lineHeight = "1.4";
  playbackWarning.style.marginBottom = "8px";
  playbackWarning.style.padding = "8px";
  playbackWarning.style.borderRadius = "8px";
  playbackWarning.style.background = "rgba(245, 158, 11, 0.15)";
  playbackWarning.style.border = "1px solid rgba(245, 158, 11, 0.35)";
  playbackWarning.style.color = "#fcd34d";
  playbackWarning.textContent = "Tap to enable sound.";

  const playbackEnableBtn = document.createElement("button");
  playbackEnableBtn.setAttribute("data-voicethere-playback-enable", "");
  playbackEnableBtn.type = "button";
  playbackEnableBtn.textContent = "Enable sound";
  playbackEnableBtn.style.marginTop = "6px";
  playbackEnableBtn.style.padding = "6px 10px";
  playbackEnableBtn.style.borderRadius = "6px";
  playbackEnableBtn.style.border = "none";
  playbackEnableBtn.style.cursor = "pointer";
  playbackEnableBtn.style.fontSize = "11px";
  playbackWarning.append(playbackEnableBtn);

  const transcript = document.createElement("div");
  transcript.className = WIDGET_CSS_CLASSES.transcript;
  transcript.style.flex = "1";
  transcript.style.overflow = "auto";
  transcript.style.display = "flex";
  transcript.style.flexDirection = "column";
  transcript.style.gap = "6px";
  transcript.style.minHeight = "160px";
  transcript.style.maxHeight = "260px";
  transcript.style.padding = "4px 0";

  const inline = runtime.display === "inline";

  // One `<time>` per bubble, set when the bubble is created and never moved
  // by later text updates. Show, format and colour follow the live theme.
  const timeEntries: Array<{ el: HTMLElement; at: Date }> = [];
  const renderTimeEntry = (entry: { el: HTMLElement; at: Date }) => {
    const ts = runtime.theme?.chat?.timestamps;
    entry.el.style.display = ts?.show === false ? "none" : "block";
    entry.el.style.color = ts?.color ?? "";
    entry.el.style.opacity = ts?.color ? "1" : "0.6";
    entry.el.textContent = formatWidgetTime(entry.at, ts?.format ?? "auto");
  };
  const attachTime = (bubble: HTMLElement, at: Date) => {
    const el = document.createElement("time");
    el.className = WIDGET_CSS_CLASSES.msgTime;
    el.setAttribute("datetime", at.toISOString());
    el.style.fontSize = "10px";
    el.style.marginTop = "2px";
    el.style.textAlign = "end";
    const entry = { el, at };
    timeEntries.push(entry);
    renderTimeEntry(entry);
    bubble.append(el);
  };

  const addBubble = (
    role: TranscriptRole,
    kind: TranscriptBubbleKind,
    text: string,
    opts: { turnId?: string; muted?: boolean } = {},
  ): HTMLDivElement | null => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const bubble = createTranscriptBubbleElement(role, trimmed);
    bubble.setAttribute("data-voicethere-kind", kind);
    if (opts.turnId) bubble.setAttribute("data-voicethere-turn", opts.turnId);
    if (kind === "filler") {
      bubble.classList.add(WIDGET_CSS_CLASSES.msgFiller);
      bubble.style.opacity = "0.7";
      bubble.style.fontStyle = "italic";
    }
    if (role !== "system") attachTime(bubble, new Date());
    transcript.append(bubble);
    transcript.scrollTop = transcript.scrollHeight;
    return bubble;
  };

  /**
   * A link the agent sent as `assistant_content`, as its own incoming bubble at
   * arrival time, so it never moves. Only https URLs; the check is repeated
   * here so the widget never renders another scheme as a link.
   */
  const addLinkBubble = (content: AgentContent, turnId?: string) => {
    let url: URL;
    try {
      url = new URL(content.url);
    } catch {
      return;
    }
    if (url.protocol !== "https:") return;
    const bubble = createTranscriptBubbleElement("incoming", "");
    bubble.classList.add(WIDGET_CSS_CLASSES.msgLink);
    bubble.setAttribute("data-voicethere-kind", "link");
    if (turnId) bubble.setAttribute("data-voicethere-turn", turnId);
    const textEl = bubbleTextElement.get(bubble);
    textEl?.remove();
    bubbleTextElement.delete(bubble);
    bubble.style.border = "1px solid currentColor";
    let allowed = true;
    if (runtime.isLinkAllowed) {
      try {
        allowed = runtime.isLinkAllowed(url) === true;
      } catch (error) {
        console.warn("VoiceThere widget: host callback threw", error);
        allowed = false;
      }
    }
    const row = allowed
      ? document.createElement("a")
      : document.createElement("span");
    row.style.color = "inherit";
    row.style.textDecoration = "none";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "6px";
    row.style.wordBreak = "break-all";
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.style.display = "inline-flex";
    icon.innerHTML = LINK_ICON_SVG;
    const label = document.createElement("span");
    label.textContent = content.label?.trim() || linkLabelFromUrl(url);
    row.append(icon, label);
    bubble.append(row);
    if (allowed) {
      const anchor = row as HTMLAnchorElement;
      anchor.href = url.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      bubble.style.cursor = "pointer";
      // The whole bubble is the button: a click outside the anchor follows it.
      bubble.addEventListener("click", (event: { target?: unknown }) => {
        if (event.target instanceof Node && anchor.contains(event.target))
          return;
        anchor.click();
      });
    }
    attachTime(bubble, new Date());
    transcript.append(bubble);
    transcript.scrollTop = transcript.scrollHeight;
  };

  const incomingBubbleByUtteranceId = new Map<string, HTMLDivElement>();

  const upsertIncomingTranscriptBubble = (
    utteranceId: string,
    visibleText: string,
  ) => {
    const existing = incomingBubbleByUtteranceId.get(utteranceId);
    if (!existing) {
      const created = addBubble("incoming", "reply", visibleText, {
        turnId: utteranceId,
      });
      if (created) incomingBubbleByUtteranceId.set(utteranceId, created);
      return;
    }
    setBubbleText(existing, visibleText);
    transcript.scrollTop = transcript.scrollHeight;
  };

  // Always present: with streamSpokenText false it shows spoken replies at once.
  const makeSpokenCaption = () =>
    createSpokenChatCaption({
      enabled: runtime.streamSpokenText,
      paceChatReply: runtime.paceChatReply,
      onUpsert: upsertIncomingTranscriptBubble,
    });
  let spokenCaption = makeSpokenCaption();

  const composer = document.createElement("div");
  composer.className = WIDGET_CSS_CLASSES.composer;
  composer.style.marginTop = "8px";

  const input = document.createElement("input");
  input.className = WIDGET_CSS_CLASSES.input;
  input.placeholder = "Type a message…";
  input.style.width = "100%";
  input.style.padding = "8px";
  input.style.borderRadius = "8px";
  input.style.border = "1px solid rgba(255,255,255,0.15)";
  input.style.background = "var(--vt-input-bg)";
  input.style.color = "var(--vt-input-fg)";
  input.style.boxSizing = "border-box";

  const connectBtn = document.createElement("button");
  connectBtn.type = "button";
  connectBtn.className = WIDGET_CSS_CLASSES.connect;
  connectBtn.textContent = "Connect";
  connectBtn.style.marginTop = "8px";
  connectBtn.style.width = "100%";
  connectBtn.style.padding = "8px";
  connectBtn.style.borderRadius = "8px";
  connectBtn.style.border = "none";
  connectBtn.style.cursor = "pointer";

  composer.append(input, connectBtn);

  panel.style.display = "none";
  panel.style.flexDirection = "column";
  panel.append(
    header,
    greeting,
    status,
    micWarning,
    playbackWarning,
    transcript,
    composer,
  );
  if (inline) {
    closeBtn.style.display = "none";
    root.append(panel, inboundAudio);
  } else {
    root.append(launcher, panel, inboundAudio);
  }
  mount.append(root);

  let session: Awaited<ReturnType<typeof connectBrowserSession>> | null = null;
  // Set when the current session has been reported to onSessionEnd.
  let sessionEndReported = true;
  const reportSessionEnd = (info: VoiceThereWidgetSessionEnd) => {
    if (sessionEndReported) return;
    sessionEndReported = true;
    callHost(runtime.onSession, null);
    callHost(runtime.onSessionEnd, info);
  };
  let isOpen = false;
  let startAbortController: AbortController | null = null;
  let destroyed = false;

  const debug = createDebugConsole((event) => {
    // The transcript is the primary UI; events only reach the host hook.
    callHost(runtime.onDebugEvent, event);
  });

  const refreshGreetingBubble = () => {
    const firstSystem = transcript.querySelector(
      `.${WIDGET_CSS_CLASSES.msgSystem}`,
    );
    if (firstSystem) {
      firstSystem.remove();
    }
    greeting.textContent = runtime.greeting ?? "";
    if (runtime.greeting?.trim()) {
      addBubble("system", "greeting", runtime.greeting);
    }
  };

  let resolvedTheme: ResolvedWidgetTheme;

  const applyAppearance = () => {
    resolvedTheme = applyPreset(
      { root, launcher, panel },
      runtime.preset,
      runtime.theme,
    );
    applyWidgetPosition(
      root,
      runtime.position,
      runtime.preset,
      runtime.positionOffset,
    );
    applyWidgetCssVariables(root, resolvedTheme, runtime.theme, runtime.preset);
    applyAccentTheme(
      [micRequestBtn, playbackEnableBtn, connectBtn],
      resolvedTheme,
    );
    if (inline) {
      // The panel fills the mount; no floating position, no fixed panel size.
      root.style.position = "relative";
      root.style.zIndex = "";
      root.style.top = "";
      root.style.right = "";
      root.style.bottom = "";
      root.style.left = "";
      root.style.transform = "";
      root.style.width = "100%";
      root.style.height = "100%";
      root.style.alignItems = "stretch";
      panel.style.width = "100%";
      panel.style.height = "100%";
      panel.style.minHeight = "0";
      transcript.style.maxHeight = "none";
      transcript.style.minHeight = "0";
    }
    for (const entry of timeEntries) renderTimeEntry(entry);
    launcher.textContent = runtime.launcherLabel;
    headerTitle.textContent = runtime.launcherLabel;
    input.style.background = "var(--vt-input-bg)";
    input.style.color = "var(--vt-input-fg)";
    header.style.background = "var(--vt-header-bg)";
    syncCustomCssStyle(root, runtime.customCss);
    refreshGreetingBubble();
  };

  applyAppearance();
  if (inline) {
    panel.style.display = "flex";
    root.dataset.vtOpen = "true";
  }

  const setOpen = (open: boolean) => {
    if (inline) return;
    isOpen = open;
    if (open) {
      panel.style.display = "flex";
      launcher.style.display = "none";
      root.dataset.vtOpen = "true";
    } else {
      panel.style.display = "none";
      launcher.style.display = "";
      delete root.dataset.vtOpen;
    }
  };

  const hideSessionNotices = () => {
    micWarning.style.display = "none";
    playbackWarning.style.display = "none";
  };

  const refreshMicNotice = () => {
    if (
      !session ||
      !isVoiceSessionMode(session.mode) ||
      runtime.audio?.silent
    ) {
      micWarning.style.display = "none";
      return;
    }
    const micState = session.getAudioInputState();
    micWarning.style.display = isMicLimitedState(micState) ? "block" : "none";
  };

  micRequestBtn.onclick = () => {
    void (async () => {
      if (!session) return;
      await session.requestAudioInputAccess();
      refreshMicNotice();
    })();
  };

  playbackEnableBtn.onclick = () => {
    void (async () => {
      if (!session) return;
      const ok = await session.unlockAudioPlayback();
      if (ok) {
        playbackWarning.style.display = "none";
      }
    })();
  };

  connectBtn.onclick = () => {
    void unlockAudioPlayback(inboundAudio);
    void (async () => {
      if (session) {
        session.disconnect();
        session = null;
        spokenCaption.dispose();
        hideSessionNotices();
        setStatusDisplay("Disconnected");
        reportSessionEnd({ reason: "closed" });
        connectBtn.textContent = "Connect";
        connectBtn.title = "";
        return;
      }

      lastRecoveryState = undefined;
      setStatusDisplay("Connecting…", true);
      const startAbort = new AbortController();
      startAbortController = startAbort;
      let started: StartSessionResult;
      if (runtime.startSession) {
        try {
          started = await runtime.startSession(startAbort.signal);
        } catch (error) {
          started = {
            ok: false,
            code: "HTTP_ERROR",
            message:
              error instanceof Error && error.message
                ? error.message
                : "Could not start the session",
          };
        }
      } else {
        started = await startSession({
          apiBase: runtime.apiBase,
          projectId: runtime.projectId,
          headers: { Authorization: `Bearer ${runtime.clientKey}` },
          onStatus: (s) => {
            if (s.status === "waiting") {
              const position =
                s.queue_position != null
                  ? ` (position ${s.queue_position})`
                  : "";
              setStatusDisplay(`Waiting for capacity${position}…`, true);
            } else if (s.status === "failed") {
              setStatusDisplay(s.failure_message ?? "Provisioning failed");
            }
          },
          debug,
        });
      }
      if (startAbort.signal.aborted) return;

      if (!started.ok) {
        if (
          runtime.clientKey &&
          (started.httpStatus === 401 || started.httpStatus === 403)
        ) {
          // The key was rejected; drop its cached project pointer.
          void clearWidgetKeyPointer(runtime.clientKey).catch(() => undefined);
        }
        setStatusDisplay(started.message);
        return;
      }

      const handleWidgetControl = (payload: Record<string, unknown>) => {
        const spokenAssistant =
          payload.spoken === true &&
          (payload.type === "assistant_delta" ||
            payload.type === "assistant_done");
        if (
          spokenAssistant ||
          (runtime.streamSpokenText && runtime.paceChatReply)
        ) {
          // Spoken turns, and every agent message when chat replies are paced too.
          spokenCaption.handleControlMessage(payload);
          return;
        }
        if (runtime.streamSpokenText && payload.type === "speech_event") {
          // Default: speech events only pace spoken turns; typed text below is unchanged.
          spokenCaption.handleControlMessage(payload);
        }
        const incoming = incomingTextFromControlMessage(payload);
        if (incoming) {
          const kind = controlMessageKind(payload);
          // The caller's own words sit on the user side, like typed chat.
          addBubble(
            kind === "speech" ? "outgoing" : "incoming",
            kind,
            incoming,
            {
              turnId:
                typeof payload.turnId === "string" ? payload.turnId : undefined,
            },
          );
        }
      };

      session = await connectBrowserSession({
        mode,
        credentials: started.credentials,
        audioElement: inboundAudio,
        onDebugEvent: debug,
        runtime: runtime.runtime,
        audioInputDeviceId: runtime.audio?.deviceId,
        silentMic: runtime.audio?.silent === true ? true : undefined,
        onSessionError: (event: SessionErrorEvent) => {
          if (event.recoverable !== true) {
            setStatusDisplay(event.message, false, true);
          }
          // Only an explicit `recoverable: false` is terminal.
          if (event.recoverable === false) {
            reportSessionEnd({ reason: "error", error: event });
          }
        },
        onAgentAudioTrack: (track) => {
          callHost(runtime.onAgentAudioTrack, track);
        },
        onControlMessage: (payload) => {
          handleWidgetControl(payload);
          callHost(runtime.onControlMessage, payload);
        },
        onAgentContent: (event) => {
          if (event.content.kind === "link") {
            addLinkBubble(event.content, event.turnId);
          }
        },
        onAgentFiller: (event) => {
          addBubble("incoming", "filler", event.text, {
            turnId: event.turnId,
          });
        },
        onConnectionStatus: (connectionStatus) => {
          const recovery = connectionStatus.recovery;
          const previousState = lastRecoveryState;
          lastRecoveryState = recovery?.state;
          if (recovery?.state === "interrupted") {
            setStatusDisplay(recovery.message, true);
            return;
          }
          if (recovery?.state === "lost") {
            if (previousState === "lost") return;
            setStatusDisplay(recovery.message, false, true);
            const lostSession = session;
            session = null;
            lostSession?.disconnect();
            spokenCaption.dispose();
            hideSessionNotices();
            connectBtn.textContent = "Connect";
            connectBtn.title = "";
            reportSessionEnd({ reason: "error", error: recovery });
            return;
          }
          if (recovery?.state === "restored") {
            if (previousState !== "restored") {
              restoredNoticeUntilMs = Date.now() + 3000;
              setTimeout(() => {
                if (session && lastRecoveryState === "restored") {
                  setStatusDisplay(
                    formatWebRtcStatus(session.getConnectionStatus()),
                  );
                }
              }, 3000);
            }
            if (Date.now() < restoredNoticeUntilMs) {
              setStatusDisplay(recovery.message);
              return;
            }
          }
          setStatusDisplay(formatWebRtcStatus(connectionStatus));
        },
        onReconnected: () => {
          if (session) callHost(runtime.onSession, session);
        },
        onReconnecting: (attempt) => {
          if (lastRecoveryState === "interrupted") return;
          setStatusDisplay(`Reconnecting (${attempt})…`, true);
        },
        onAudioPlayback: (playbackState) => {
          playbackWarning.style.display =
            playbackState === "blocked" ? "block" : "none";
        },
      });

      if (startAbort.signal.aborted || destroyed) {
        // The widget was destroyed while connecting (for example during the
        // microphone prompt): close the session instead of leaking it.
        const orphan = session;
        session = null;
        orphan.disconnect();
        return;
      }

      sessionEndReported = false;
      const connecting = session;
      try {
        await connecting.waitForConnected();
      } catch (error) {
        if (session !== connecting) return;
        connecting.disconnect();
        session = null;
        spokenCaption.dispose();
        hideSessionNotices();
        setStatusDisplay("Could not connect", false, true);
        connectBtn.textContent = "Connect";
        connectBtn.title = "";
        reportSessionEnd({ reason: "error", error });
        return;
      }
      if (session !== connecting) return;
      setStatusDisplay(formatWebRtcStatus(session.getConnectionStatus()));
      refreshMicNotice();
      callHost(runtime.onSession, session);
      connectBtn.textContent = "Disconnect";
      connectBtn.title =
        "Disconnect this session. Connect again to start a new orchestrator session.";
    })();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !session) return;
    const text = input.value.trim();
    if (!text) return;
    session.sendChat(text);
    addBubble("outgoing", "chat", text);
    input.value = "";
  });

  launcher.onclick = () => {
    setOpen(true);
  };

  closeBtn.onclick = () => {
    setOpen(false);
  };

  const updateConfig = (partial: Partial<VoiceThereWidgetConfigV1>) => {
    if (partial.preset !== undefined) runtime.preset = partial.preset;
    if (partial.theme !== undefined) {
      runtime.theme = { ...runtime.theme, ...partial.theme };
    }
    if (partial.launcherLabel !== undefined) {
      runtime.launcherLabel = partial.launcherLabel;
    }
    if (partial.greeting !== undefined) runtime.greeting = partial.greeting;
    if (partial.position !== undefined) runtime.position = partial.position;
    if (partial.positionOffset !== undefined) {
      runtime.positionOffset = partial.positionOffset;
    }
    if (partial.customCss !== undefined) runtime.customCss = partial.customCss;
    if (partial.streamSpokenText !== undefined) {
      runtime.streamSpokenText = partial.streamSpokenText !== false;
      runtime.paceChatReply = partial.streamSpokenText === true;
      spokenCaption.dispose();
      spokenCaption = makeSpokenCaption();
    }
    applyAppearance();
  };

  return {
    open: () => {
      setOpen(true);
    },
    close: () => {
      setOpen(false);
    },
    destroy: () => {
      destroyed = true;
      startAbortController?.abort();
      spokenCaption.dispose();
      session?.disconnect();
      session = null;
      reportSessionEnd({ reason: "closed" });
      inboundAudio.remove();
      root.remove();
    },
    updateConfig,
  };
}
