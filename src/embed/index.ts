import {
  BrowserSessionModeType,
  connectBrowserSession,
  createDebugConsole,
  startSession,
  type BrowserSessionMode,
  type WebRtcConnectionStatus,
} from "../browser/browser-session.js";

export type VoiceThereWidgetTheme = {
  primary?: string;
  background?: string;
  text?: string;
};

export type VoiceThereWidgetOptions = {
  projectId: string;
  apiBase: string;
  clientKey: string;
  mode?: BrowserSessionMode;
  theme?: VoiceThereWidgetTheme;
  mount?: HTMLElement;
};

export type VoiceThereWidget = {
  open: () => void;
  close: () => void;
  destroy: () => void;
};

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

export function createVoiceThereWidget(
  options: VoiceThereWidgetOptions,
): VoiceThereWidget {
  const mount = options.mount ?? document.body;
  const mode = options.mode ?? BrowserSessionModeType.Chat;
  const theme = options.theme ?? {};

  const root = document.createElement("div");
  root.style.position = "fixed";
  root.style.bottom = "16px";
  root.style.right = "16px";
  root.style.zIndex = "99999";
  root.style.fontFamily = "system-ui, sans-serif";

  const launcher = document.createElement("button");
  launcher.textContent = "Chat";
  launcher.style.background = theme.primary ?? "#06b6d4";
  launcher.style.color = theme.text ?? "#0f172a";
  launcher.style.border = "none";
  launcher.style.borderRadius = "999px";
  launcher.style.padding = "12px 16px";
  launcher.style.cursor = "pointer";

  const panel = document.createElement("div");
  panel.style.display = "none";
  panel.style.width = "320px";
  panel.style.height = "420px";
  panel.style.background = theme.background ?? "#0b1220";
  panel.style.color = theme.text ?? "#e2e8f0";
  panel.style.border = "1px solid rgba(255,255,255,0.1)";
  panel.style.borderRadius = "12px";
  panel.style.padding = "12px";
  panel.style.boxShadow = "0 8px 30px rgba(0,0,0,0.35)";

  const status = document.createElement("div");
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

  const log = document.createElement("pre");
  log.style.flex = "1";
  log.style.overflow = "auto";
  log.style.fontSize = "11px";
  log.style.background = "rgba(0,0,0,0.25)";
  log.style.padding = "8px";
  log.style.borderRadius = "8px";
  log.style.height = "260px";
  log.style.whiteSpace = "pre-wrap";

  const input = document.createElement("input");
  input.placeholder = "Type a message…";
  input.style.width = "100%";
  input.style.marginTop = "8px";
  input.style.padding = "8px";
  input.style.borderRadius = "8px";
  input.style.border = "1px solid rgba(255,255,255,0.15)";
  input.style.background = "#111827";
  input.style.color = "#e2e8f0";

  const connectBtn = document.createElement("button");
  connectBtn.textContent = "Connect";
  connectBtn.style.marginTop = "8px";
  connectBtn.style.width = "100%";
  connectBtn.style.padding = "8px";
  connectBtn.style.borderRadius = "8px";
  connectBtn.style.border = "none";
  connectBtn.style.background = theme.primary ?? "#06b6d4";
  connectBtn.style.color = theme.text ?? "#0f172a";
  connectBtn.style.cursor = "pointer";

  panel.append(status, log, input, connectBtn);
  root.append(launcher, panel);
  mount.append(root);

  let session: Awaited<ReturnType<typeof connectBrowserSession>> | null = null;

  const renderLog = () => {
    log.textContent = debug.exportText();
  };

  const debug = createDebugConsole(() => renderLog());

  connectBtn.onclick = () => {
    void (async () => {
      if (session) {
        session.disconnect();
        session = null;
        setStatusDisplay("Disconnected");
        connectBtn.textContent = "Connect";
        return;
      }

      setStatusDisplay("Connecting…", true);
      const started = await startSession({
        apiBase: options.apiBase,
        projectId: options.projectId,
        headers: { Authorization: `Bearer ${options.clientKey}` },
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

      renderLog();

      if (!started.ok) {
        setStatusDisplay(started.message);
        return;
      }

      session = await connectBrowserSession({
        mode,
        credentials: started.credentials,
        onDebugEvent: debug,
        onConnectionStatus: (connectionStatus) => {
          setStatusDisplay(formatWebRtcStatus(connectionStatus));
        },
        onReconnecting: (attempt) => {
          setStatusDisplay(`Reconnecting (${attempt})…`, true);
        },
      });

      await session.waitForConnected();
      setStatusDisplay(formatWebRtcStatus(session.getConnectionStatus()));
      connectBtn.textContent = "Disconnect";
      connectBtn.title =
        "Disconnect this session. Connect again to start a new orchestrator session.";
      renderLog();
    })();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !session) return;
    const text = input.value.trim();
    if (!text) return;
    session.sendChat(text);
    input.value = "";
    renderLog();
  });

  launcher.onclick = () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  };

  return {
    open: () => {
      panel.style.display = "block";
    },
    close: () => {
      panel.style.display = "none";
    },
    destroy: () => {
      session?.disconnect();
      root.remove();
    },
  };
}
