import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startSession, connectBrowserSession } = vi.hoisted(() => ({
  startSession: vi.fn(),
  connectBrowserSession: vi.fn(),
}));

vi.mock("../browser/browser-session.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../browser/browser-session.js")>();
  return {
    ...actual,
    startSession,
    connectBrowserSession,
  };
});

import { BrowserSessionModeType } from "../browser/browser-session.js";
import {
  createVoiceThereWidget,
  createVoiceThereWidgetAsync,
} from "./index.js";
import { WIDGET_PRESET_IDS } from "./config.js";

type MockElement = {
  tagName: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
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
  addEventListener: (
    type: string,
    handler: (event: { key: string }) => void,
  ) => void;
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
    dataset: {},
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

function findByAttr(root: MockElement, attr: string): MockElement | undefined {
  if (root.attrs[attr] !== undefined) return root;
  for (const child of root.children) {
    const found = findByAttr(child, attr);
    if (found) return found;
  }
  return undefined;
}

function findWidgetRoot(mount: MockElement): MockElement | undefined {
  return mount.children.find((child) => child.dataset.voicetherePreset);
}

function findButtonByText(
  root: MockElement,
  text: string,
): MockElement | undefined {
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
    if (tag === "div") {
      Object.defineProperty(el, "dataset", {
        value: el.dataset,
        writable: true,
        enumerable: true,
      });
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

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          v: 1,
          projectId: "from-config",
          apiBase: "https://cdn-config.example/v1",
          preset: "rounded-card",
          launcherLabel: "Help",
          greeting: "Hello from CDN",
          position: "bottom-left",
          mode: "chat",
        }),
    })),
  );

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

  it("applies preset layout and position from inline options", () => {
    createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      preset: "voice-orb",
      position: "bottom-left",
      theme: { primary: "#112233" },
      mount: mount as unknown as HTMLElement,
    });

    const root = findWidgetRoot(mount);
    expect(root).toBeDefined();
    expect(root!.dataset.voicetherePreset).toBe("voice-orb");
    expect(root!.dataset.voicetherePosition).toBe("bottom-left");
    expect(root!.style.left).toBe("16px");

    const launcher = root!.children.find((c) => c.tagName === "BUTTON");
    expect(launcher?.style.borderRadius).toBe("50%");
    expect(launcher?.style.background).toBe("#112233");
  });

  it("throws when configUrl is passed to sync constructor", () => {
    expect(() =>
      createVoiceThereWidget({
        clientKey: "key",
        configUrl: "https://cdn.example/config.json",
      }),
    ).toThrow(/createVoiceThereWidgetAsync/);
  });
});

describe("createVoiceThereWidgetAsync", () => {
  it("boots from mocked configUrl and merges inline clientKey", async () => {
    await createVoiceThereWidgetAsync({
      clientKey: "inline-key",
      configUrl: "https://cdn.example/widgets/w_test/config.json",
      mount: mount as unknown as HTMLElement,
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://cdn.example/widgets/w_test/config.json",
      expect.objectContaining({ credentials: "omit" }),
    );

    const root = findWidgetRoot(mount);
    expect(root?.dataset.voicetherePreset).toBe("rounded-card");
    expect(root?.dataset.voicetherePosition).toBe("bottom-left");

    const launcher = root!.children.find((c) => c.tagName === "BUTTON");
    expect(launcher?.textContent).toBe("Help");

    const greeting = findByAttr(mount, "data-voicethere-greeting");
    expect(greeting?.textContent).toBe("Hello from CDN");

    const connectBtn = findButtonByText(mount, "Connect");
    connectBtn!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "from-config",
        apiBase: "https://cdn-config.example/v1",
        headers: { Authorization: "Bearer inline-key" },
      }),
    );
  });

  it("inline options override fetched config", async () => {
    await createVoiceThereWidgetAsync({
      clientKey: "key",
      projectId: "inline-project",
      apiBase: "https://inline.example/v1",
      configUrl: "https://cdn.example/config.json",
      preset: "minimal-bar",
      mount: mount as unknown as HTMLElement,
    });

    const root = findWidgetRoot(mount);
    expect(root?.dataset.voicetherePreset).toBe("minimal-bar");

    const connectBtn = findButtonByText(mount, "Connect");
    connectBtn!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "inline-project",
        apiBase: "https://inline.example/v1",
      }),
    );
  });

  it("covers every preset id without error", () => {
    for (const preset of WIDGET_PRESET_IDS) {
      const localMount = createMockElement("div");
      createVoiceThereWidget({
        projectId: "p",
        apiBase: "https://api.example.com",
        clientKey: "key",
        preset,
        mount: localMount as unknown as HTMLElement,
      });
      expect(localMount.children[0]?.dataset.voicetherePreset).toBe(preset);
    }
  });

  describe("configUrl fetch fallback", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    const inlineBootstrap = {
      clientKey: "key",
      projectId: "inline-project",
      apiBase: "https://inline.example/v1",
      configUrl: "https://cdn.example/config.json",
      mount: mount as unknown as HTMLElement,
    };

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("falls back to inline options on HTTP 403", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "",
      } as Response);

      await createVoiceThereWidgetAsync(inlineBootstrap);

      expect(warnSpy).toHaveBeenCalled();
      const root = findWidgetRoot(mount);
      expect(root?.dataset.voicetherePreset).toBe("pill-dark");
      const launcher = root!.children.find((c) => c.tagName === "BUTTON");
      expect(launcher?.textContent).toBe("Chat");
    });

    it("falls back on network failure", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));

      await createVoiceThereWidgetAsync(inlineBootstrap);

      expect(warnSpy).toHaveBeenCalled();
      expect(findWidgetRoot(mount)).toBeDefined();
    });

    it("falls back on invalid JSON body", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => "not-json",
      } as Response);

      await createVoiceThereWidgetAsync(inlineBootstrap);

      expect(warnSpy).toHaveBeenCalled();
      expect(findWidgetRoot(mount)).toBeDefined();
    });

    it("falls back on forbidden secret key in config", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ v: 1, clientKey: "secret" }),
      } as Response);

      await createVoiceThereWidgetAsync(inlineBootstrap);

      expect(warnSpy).toHaveBeenCalled();
      expect(findWidgetRoot(mount)).toBeDefined();
    });

    it("still throws when fetch fails and inline bootstrap is missing", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "",
      } as Response);

      await expect(
        createVoiceThereWidgetAsync({
          clientKey: "key",
          configUrl: "https://cdn.example/config.json",
          mount: mount as unknown as HTMLElement,
        }),
      ).rejects.toThrow(/requires projectId/);
    });
  });
});
