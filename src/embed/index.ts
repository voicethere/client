import {
  BrowserSessionModeType,
  connectBrowserSession,
  createDebugConsole,
  startSession,
  unlockAudioPlayback,
  type BrowserSessionMode,
  type WebRtcConnectionStatus,
} from "../browser/browser-session.js";
import type { AudioInputState } from "../browser/microphone.js";
import {
  fetchVoiceThereWidgetConfig,
  WidgetConfigError,
  widgetConfigModeToSessionMode,
  type VoiceThereWidgetConfigV1,
  type VoiceThereWidgetTheme,
  type WidgetPosition,
  type WidgetPositionOffset,
  type WidgetPresetId,
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
import { createSpokenChatCaption } from "./spoken-chat-caption.js";

export type {
  VoiceThereWidgetConfigV1,
  VoiceThereWidgetTheme,
  WidgetPosition,
  WidgetPositionOffset,
  WidgetPresetId,
};
export {
  WidgetConfigError,
  fetchVoiceThereWidgetConfig,
  parseVoiceThereWidgetConfigJson,
  parseVoiceThereWidgetConfigV1,
  WIDGET_CONFIG_VERSION,
  WIDGET_POSITIONS,
  WIDGET_PRESET_IDS,
} from "./config.js";
export { applyPreset, getWidgetPreset } from "./presets.js";
export { WIDGET_CSS_CLASSES, WIDGET_CSS_VARIABLES } from "./css.js";

export type VoiceThereWidgetOptions = {
  clientKey: string;
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
  clientKey: string;
  mode: BrowserSessionMode;
  theme?: VoiceThereWidgetTheme;
  mount?: HTMLElement;
  preset: WidgetPresetId;
  launcherLabel: string;
  greeting?: string;
  position: WidgetPosition;
  positionOffset?: WidgetPositionOffset;
  customCss?: string;
  streamSpokenText: boolean;
};

function mergeWidgetOptions(
  inline: VoiceThereWidgetOptions,
  remote?: VoiceThereWidgetConfigV1,
): ResolvedVoiceThereWidgetOptions {
  const projectId = inline.projectId ?? remote?.projectId;
  const apiBase = inline.apiBase ?? remote?.apiBase;
  if (!projectId) {
    throw new Error(
      "VoiceThere widget requires projectId (inline or from configUrl)",
    );
  }
  if (!apiBase) {
    throw new Error(
      "VoiceThere widget requires apiBase (inline or from configUrl)",
    );
  }

  const mode =
    inline.mode ??
    widgetConfigModeToSessionMode(remote?.mode) ??
    BrowserSessionModeType.Chat;

  return {
    projectId,
    apiBase,
    clientKey: inline.clientKey,
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
      inline.streamSpokenText ?? remote?.streamSpokenText ?? false,
  };
}

export async function createVoiceThereWidgetAsync(
  options: VoiceThereWidgetOptions,
): Promise<VoiceThereWidget> {
  let remote: VoiceThereWidgetConfigV1 | undefined;
  if (options.configUrl) {
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
  }
  return buildVoiceThereWidget(mergeWidgetOptions(options, remote));
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

function appendTranscriptBubble(
  transcript: HTMLElement,
  role: TranscriptRole,
  text: string,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  transcript.append(createTranscriptBubbleElement(role, trimmed));
  transcript.scrollTop = transcript.scrollHeight;
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
  bubble.textContent = text;
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

function buildVoiceThereWidget(
  initialOptions: ResolvedVoiceThereWidgetOptions,
): VoiceThereWidget {
  const runtime: ResolvedVoiceThereWidgetOptions = { ...initialOptions };
  const mount = runtime.mount ?? document.body;
  const mode = runtime.mode;

  const root = document.createElement("div");
  root.className = WIDGET_CSS_CLASSES.root;
  root.style.position = "fixed";
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

  const setStatusDisplay = (text: string, loading = false) => {
    statusText.textContent = text;
    statusSpinner.style.display = loading ? "inline-block" : "none";
  };

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

  const incomingBubbleByUtteranceId = new Map<string, HTMLDivElement>();

  const upsertIncomingTranscriptBubble = (
    utteranceId: string,
    visibleText: string,
  ) => {
    let bubble = incomingBubbleByUtteranceId.get(utteranceId);
    if (!bubble) {
      if (!visibleText.trim()) return;
      bubble = createTranscriptBubbleElement("incoming", visibleText);
      incomingBubbleByUtteranceId.set(utteranceId, bubble);
      transcript.append(bubble);
    } else {
      bubble.textContent = visibleText;
    }
    transcript.scrollTop = transcript.scrollHeight;
  };

  let spokenCaption = runtime.streamSpokenText
    ? createSpokenChatCaption({
        enabled: true,
        onUpsert: upsertIncomingTranscriptBubble,
      })
    : null;

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
  root.append(launcher, panel, inboundAudio);
  mount.append(root);

  let session: Awaited<ReturnType<typeof connectBrowserSession>> | null = null;
  let isOpen = false;

  const debug = createDebugConsole(() => {
    /* transcript is primary UI; debug export kept for session wiring */
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
      appendTranscriptBubble(transcript, "system", runtime.greeting);
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
    launcher.textContent = runtime.launcherLabel;
    headerTitle.textContent = runtime.launcherLabel;
    input.style.background = "var(--vt-input-bg)";
    input.style.color = "var(--vt-input-fg)";
    header.style.background = "var(--vt-header-bg)";
    syncCustomCssStyle(root, runtime.customCss);
    refreshGreetingBubble();
  };

  applyAppearance();

  const setOpen = (open: boolean) => {
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
    if (!session || !isVoiceSessionMode(session.mode)) {
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
        spokenCaption?.dispose();
        hideSessionNotices();
        setStatusDisplay("Disconnected");
        connectBtn.textContent = "Connect";
        connectBtn.title = "";
        return;
      }

      setStatusDisplay("Connecting…", true);
      const started = await startSession({
        apiBase: runtime.apiBase,
        projectId: runtime.projectId,
        headers: { Authorization: `Bearer ${runtime.clientKey}` },
        onStatus: (s) => {
          if (s.status === "waiting") {
            const position =
              s.queue_position != null ? ` (position ${s.queue_position})` : "";
            setStatusDisplay(`Waiting for capacity${position}…`, true);
          } else if (s.status === "failed") {
            setStatusDisplay(s.failure_message ?? "Provisioning failed");
          }
        },
        debug,
      });

      if (!started.ok) {
        setStatusDisplay(started.message);
        return;
      }

      session = await connectBrowserSession({
        mode,
        credentials: started.credentials,
        audioElement: inboundAudio,
        onDebugEvent: debug,
        onControlMessage: (payload) => {
          if (spokenCaption) {
            spokenCaption.handleControlMessage(payload);
            return;
          }
          const incoming = incomingTextFromControlMessage(payload);
          if (incoming) {
            appendTranscriptBubble(transcript, "incoming", incoming);
          }
        },
        onConnectionStatus: (connectionStatus) => {
          setStatusDisplay(formatWebRtcStatus(connectionStatus));
        },
        onReconnecting: (attempt) => {
          setStatusDisplay(`Reconnecting (${attempt})…`, true);
        },
        onAudioPlayback: (playbackState) => {
          playbackWarning.style.display =
            playbackState === "blocked" ? "block" : "none";
        },
      });

      await session.waitForConnected();
      setStatusDisplay(formatWebRtcStatus(session.getConnectionStatus()));
      refreshMicNotice();
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
    appendTranscriptBubble(transcript, "outgoing", text);
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
      runtime.streamSpokenText = partial.streamSpokenText;
      if (runtime.streamSpokenText) {
        if (!spokenCaption) {
          spokenCaption = createSpokenChatCaption({
            enabled: true,
            onUpsert: upsertIncomingTranscriptBubble,
          });
        } else {
          spokenCaption.setEnabled(true);
        }
      } else if (spokenCaption) {
        spokenCaption.dispose();
        spokenCaption = null;
      }
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
      spokenCaption?.dispose();
      session?.disconnect();
      inboundAudio.remove();
      root.remove();
    },
    updateConfig,
  };
}
