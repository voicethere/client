import { connectVoiceSession } from "../../src/index.js";
import type { ConnectedClient } from "../../src/types.js";

type SessionResponse = {
  session_id: string;
  join_token: string;
  signaling_url: string;
  room_id: string;
  ice_servers?: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
};

const logEl = document.querySelector("#log") as HTMLDivElement;
const statusEl = document.querySelector("#status") as HTMLParagraphElement;
const formEl = document.querySelector("#connect-form") as HTMLFormElement;
const connectBtn = document.querySelector("#connect-btn") as HTMLButtonElement;
const disconnectBtn = document.querySelector("#disconnect-btn") as HTMLButtonElement;

let activeClient: ConnectedClient | null = null;

function log(message: string): void {
  const stamp = new Date().toLocaleTimeString();
  logEl.textContent = `[${stamp}] ${message}\n${logEl.textContent ?? ""}`;
}

function setStatus(message: string, kind: "ok" | "err" | "" = ""): void {
  statusEl.textContent = message;
  statusEl.className = kind ? `status ${kind}` : "status";
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : window.location.origin;
}

async function startSession(
  apiBase: string,
  apiKey: string,
  projectId: string,
): Promise<SessionResponse> {
  const response = await fetch(`${apiBase}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ project_id: projectId.trim() }),
  });

  const body = (await response.json()) as SessionResponse & {
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(body.error?.message ?? `Session start failed (${response.status})`);
  }

  return body;
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();

  const apiBase = normalizeBaseUrl(
    (document.querySelector("#api-base") as HTMLInputElement).value,
  );
  const apiKey = (document.querySelector("#api-key") as HTMLTextAreaElement).value.trim();
  const projectId = (document.querySelector("#project-id") as HTMLInputElement).value.trim();

  if (!apiKey || !projectId) {
    setStatus("API key and project ID are required.", "err");
    return;
  }

  connectBtn.disabled = true;
  disconnectBtn.disabled = true;
  setStatus("Starting session…");

  try {
    if (activeClient) {
      activeClient.disconnect();
      activeClient = null;
    }

    log(`POST ${apiBase}/sessions (project ${projectId.slice(0, 8)}…)`);
    const session = await startSession(apiBase, apiKey, projectId);
    log(`Session minted: ${session.session_id}`);

    setStatus("Connecting to signaling…");
    activeClient = await connectVoiceSession({
      mode: "cloud",
      credentials: {
        sessionId: session.session_id,
        joinToken: session.join_token,
        signalingUrl: session.signaling_url,
        roomId: session.room_id,
        iceServers: session.ice_servers,
      },
    });

    activeClient.on("connected", () => log("signaling connected"));
    activeClient.on("peer-joined", (peerId) => log(`peer-joined ${peerId}`));
    activeClient.on("peer-left", (peerId) => log(`peer-left ${peerId}`));
    activeClient.on("offer", (payload) => log(`offer from ${payload.from ?? "unknown"}`));
    activeClient.on("answer", (payload) => log(`answer from ${payload.from ?? "unknown"}`));
    activeClient.on("ice-candidate", (payload) =>
      log(`ice-candidate from ${payload.from ?? "unknown"}`),
    );
    activeClient.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`error: ${message}`);
      setStatus(message, "err");
    });

    log(`connected as ${activeClient.peerId} in room ${activeClient.roomId}`);
    setStatus(`Connected — peer ${activeClient.peerId}`, "ok");
    disconnectBtn.disabled = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`connect failed: ${message}`);
    setStatus(message, "err");
  } finally {
    connectBtn.disabled = false;
  }
});

disconnectBtn.addEventListener("click", () => {
  if (activeClient) {
    activeClient.disconnect();
    log("disconnected");
    activeClient = null;
  }
  disconnectBtn.disabled = true;
  setStatus("Disconnected");
});

log("Ready — paste a client API key and project ID, then Connect.");
