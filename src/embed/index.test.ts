import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startSession, connectBrowserSession } = vi.hoisted(() => ({
  startSession: vi.fn(),
  connectBrowserSession: vi.fn(),
}));

vi.mock("../browser/browser-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../browser/browser-session.js")>();
  return {
    ...actual,
    startSession,
    connectBrowserSession,
  };
});

import { BrowserSessionModeType } from "../browser/browser-session.js";
import { createVoiceThereWidget } from "./index.js";

type MockElement = {
  tagName: string;
  style: Record<string, string>;
  children: MockElement[];
  attrs: Record<string, string>;
  textContent: string;
  onclick: (() => void) | null;
  onkeydown: ((event: { key: string }) => void) | null;
  append: (...nodes: MockElement[]) => void;
  appendChild: (node: MockElement) => void;
  remove: () => void;
  setAttribute: (name: string, value?: string) => void;
  getAttribute: (name: string) => string | null;
  addEventListener: (type: string, handler: (event: { key: string }) => void) => void;
  click: () => void;
  placeholder?: string;
  title?: string;
  autoplay?: boolean;
  srcObject?: unknown;
  play?: ReturnType<typeof vi.fn>;
};

function createMockElement(tag: string): MockElement {
  const el: MockElement = {
    tagName: tag.toUpperCase(),
    style: {},
    children: [],
    attrs: {},
    textContent: "",
    onclick: null,
    onkeydown: null,
    append(...nodes: MockElement[]) {
      this.children.push(...nodes);
    },
    appendChild(node: MockElement) {
      this.children.push(node);
    },
    remove() {
      /* no-op */
    },
    setAttribute(name: string, value = "") {
      this.attrs[name] = value;
    },
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
    addEventListener(type: string, handler: (event: { key: string }) => void) {
      if (type === "keydown") {
        this.onkeydown = handler;
      }
    },
    click() {
      this.onclick?.();
    },
  };
  return el;
}

function findByAttr(
  root: MockElement,
  attr: string,
): MockElement | undefined {
  if (root.attrs[attr] !== undefined) return root;
  for (const child of root.children) {
    const found = findByAttr(child, attr);
    if (found) return found;
  }
  return undefined;
}

function findButtonByText(root: MockElement, text: string): MockElement | undefined {
  if (root.tagName === "BUTTON" && root.textContent === text) return root;
  for (const child of root.children) {
    const found = findButtonByText(child, text);
    if (found) return found;
  }
  return undefined;
}

let mount: MockElement;
let createdElements: MockElement[];

beforeEach(() => {
  createdElements = [];
  mount = createMockElement("div");

  const createElement = (tag: string): MockElement => {
    const el = createMockElement(tag);
    if (tag === "audio") {
      el.play = vi.fn(async () => undefined);
      el.autoplay = true;
    }
  if (tag === "button") {
      el.textContent = "";
    }
    createdElements.push(el);
    return el;
  };

  vi.stubGlobal("document", {
    body: mount,
    head: createMockElement("head"),
    createElement,
    getElementById: () => null,
  });

  startSession.mockResolvedValue({
    ok: true,
    credentials: {
      session_id: "s",
      mode: "voice",
      room_id: "r",
      join_token: "j",
      signaling_url: "ws://127.0.0.1:8080/ws",
      ice_servers: [],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  const requestAudioInputAccess = vi.fn(async () => false);
  connectBrowserSession.mockResolvedValue({
    mode: BrowserSessionModeType.Voice,
    disconnect: vi.fn(),
    waitForConnected: vi.fn(async () => undefined),
    getConnectionStatus: () => ({
      ready: true,
      phase: "connected",
      signalingJoined: true,
      peerConnectionState: "connected",
      inboundAudioTrack: true,
      outboundAudioTrack: true,
      controlChannelOpen: true,
      syncChannelOpen: true,
    }),
    getAudioInputState: () => "denied" as const,
    requestAudioInputAccess,
    unlockAudioPlayback: vi.fn(async () => true),
    getAudioPlaybackState: () => "idle" as const,
    sendChat: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("createVoiceThereWidget", () => {
  it("shows mic warning after voice connect when microphone is denied", async () => {
    createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mode: BrowserSessionModeType.Voice,
      mount: mount as unknown as HTMLElement,
    });

    const connectBtn = findButtonByText(mount, "Connect");
    expect(connectBtn).toBeDefined();
    connectBtn!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startSession).toHaveBeenCalled();
    expect(connectBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: BrowserSessionModeType.Voice,
        audioElement: expect.any(Object),
      }),
    );

    const micWarning = findByAttr(mount, "data-voicethere-mic-warning");
    expect(micWarning).toBeDefined();
    expect(micWarning!.style.display).toBe("block");

    const micRequest = findByAttr(mount, "data-voicethere-mic-request");
    expect(micRequest).toBeDefined();
    micRequest!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const session = await connectBrowserSession.mock.results[0]!.value;
    expect(session.requestAudioInputAccess).toHaveBeenCalled();
  });
});
