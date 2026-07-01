import {
  BrowserSessionModeType,
  createDebugConsole,
  startSession,
} from "../browser/browser-session.js";
import {
  connectBrowserSession,
  type BrowserSessionMode,
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
  status.textContent = "Disconnected";

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
        status.textContent = "Disconnected";
        connectBtn.textContent = "Connect";
        return;
      }

      status.textContent = "Provisioning…";
      const started = await startSession({
        apiBase: options.apiBase,
        projectId: options.projectId,
        headers: { Authorization: `Bearer ${options.clientKey}` },
        onStatus: (s) => {
          status.textContent = `Status: ${s.status}`;
        },
        debug,
      });

      renderLog();

      if (!started.ok) {
        status.textContent = started.message;
        return;
      }

      session = await connectBrowserSession({
        mode,
        credentials: started.credentials,
        onDebugEvent: debug,
        onReconnecting: (attempt) => {
          status.textContent = `Reconnecting (${attempt})…`;
        },
      });

      await session.waitForConnected();
      status.textContent = "Connected";
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
