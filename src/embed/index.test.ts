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
  WIDGET_CSS_CLASSES,
  WIDGET_CSS_VARIABLES,
} from "./index.js";
import { WIDGET_PRESET_IDS } from "./config.js";

type MockElement = {
  tagName: string;
  className: string;
  classList: {
    add: (...tokens: string[]) => void;
    contains: (token: string) => boolean;
  };
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
  querySelector: (selector: string) => MockElement | null;
  addEventListener: (
    type: string,
    handler: (event: { key: string }) => void,
  ) => void;
  click: () => void;
  placeholder?: string;
  title?: string;
  type?: string;
  autoplay?: boolean;
  srcObject?: unknown;
  play?: ReturnType<typeof vi.fn>;
  scrollTop?: number;
};

function createMockElement(tag: string): MockElement {
  const classTokens = new Set<string>();
  const el = {} as MockElement;
  Object.defineProperty(el, "className", {
    enumerable: true,
    configurable: true,
    get() {
      return [...classTokens].join(" ");
    },
    set(value: string) {
      classTokens.clear();
      for (const token of value.split(/\s+/).filter(Boolean)) {
        classTokens.add(token);
      }
    },
  });
  Object.assign(el, {
    tagName: tag.toUpperCase(),
    classList: {
      add(...tokens: string[]) {
        for (const t of tokens) {
          classTokens.add(t);
        }
      },
      contains(token: string) {
        return classTokens.has(token);
      },
    },
    style: (() => {
      const style: Record<string, string> = {};
      Object.assign(style, {
        setProperty(name: string, value: string) {
          style[name] = value;
        },
      });
      return style;
    })(),
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
    querySelector(selector: string) {
      const matchClass = selector.match(/^\.(.+)$/);
      if (matchClass) {
        const walk = (node: MockElement): MockElement | null => {
          if (node.classList.contains(matchClass[1]!)) return node;
          for (const child of node.children) {
            const found = walk(child);
            if (found) return found;
          }
          return null;
        };
        return walk(this);
      }
      const attrMatch = selector.match(/^\[([^\]]+)\]$/);
      if (attrMatch) {
        const walk = (node: MockElement): MockElement | null => {
          if (node.attrs[attrMatch[1]!] !== undefined) return node;
          for (const child of node.children) {
            const found = walk(child);
            if (found) return found;
          }
          return null;
        };
        return walk(this);
      }
      return null;
    },
    addEventListener(type: string, handler: (event: { key: string }) => void) {
      if (type === "keydown") {
        this.onkeydown = handler;
      }
    },
    click() {
      this.onclick?.();
    },
    scrollTop: 0,
  });
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
  return mount.children.find(
    (child) =>
      child.dataset.voicetherePreset ||
      child.classList.contains(WIDGET_CSS_CLASSES.root),
  );
}

function findLauncher(root: MockElement): MockElement | undefined {
  return root.children.find(
    (c) =>
      c.tagName === "BUTTON" &&
      c.classList.contains(WIDGET_CSS_CLASSES.launcher),
  );
}

function findPanel(root: MockElement): MockElement | undefined {
  return root.children.find((c) =>
    c.classList.contains(WIDGET_CSS_CLASSES.panel),
  );
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

    const launcher = findLauncher(root!);
    expect(launcher?.style.borderRadius).toBe("50%");
    expect(launcher?.style.background).toBe("#112233");
  });

  it("hides launcher when open and restores on close", () => {
    const widget = createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mount: mount as unknown as HTMLElement,
    });

    const root = findWidgetRoot(mount)!;
    const launcher = findLauncher(root)!;
    const panel = findPanel(root)!;

    widget.open();
    expect(launcher.style.display).toBe("none");
    expect(panel.style.display).toBe("flex");
    expect(root.dataset.vtOpen).toBe("true");

    widget.close();
    expect(launcher.style.display).toBe("");
    expect(panel.style.display).toBe("none");
    expect(root.dataset.vtOpen).toBeUndefined();
  });

  it("applies top-left position and custom CSS style tag", () => {
    createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      position: "top-left",
      customCss: ".vt-widget-launcher { font-weight: bold; }",
      mount: mount as unknown as HTMLElement,
    });

    const root = findWidgetRoot(mount)!;
    expect(root.style.top).toBe("16px");
    expect(root.style.left).toBe("16px");

    const styleTag = root.children.find(
      (c) =>
        c.tagName === "STYLE" && c.attrs["data-vt-widget-custom"] !== undefined,
    );
    expect(styleTag?.textContent).toContain("font-weight: bold");
  });

  it("sets incoming/outgoing font CSS variables from theme.chat", () => {
    createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      theme: {
        chat: {
          incoming: { fontFamily: "Georgia, serif", fontSize: "15px" },
          outgoing: { fontFamily: "Courier, monospace", fontSize: "13px" },
        },
      },
      mount: mount as unknown as HTMLElement,
    });

    const root = findWidgetRoot(mount)!;
    expect(root.style["--vt-font-incoming"]).toBe("Georgia, serif");
    expect(root.style["--vt-font-outgoing"]).toBe("Courier, monospace");
    expect(root.style["--vt-font-size-incoming"]).toBe("15px");
    expect(root.style["--vt-font-size-outgoing"]).toBe("13px");
  });

  it("updateConfig changes greeting without remounting session wiring", () => {
    const widget = createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      greeting: "Hello",
      mount: mount as unknown as HTMLElement,
    });

    const greeting = findByAttr(mount, "data-voicethere-greeting");
    expect(greeting?.textContent).toBe("Hello");

    widget.updateConfig({ greeting: "Updated greeting" });
    expect(greeting?.textContent).toBe("Updated greeting");
  });

  it("exports stable CSS class and variable lists", () => {
    expect(WIDGET_CSS_CLASSES.root).toBe("vt-widget");
    expect(WIDGET_CSS_VARIABLES).toContain("--vt-color-primary");
  });

  it("throws when configUrl is passed to sync constructor", () => {
    expect(() =>
      createVoiceThereWidget({
        clientKey: "key",
        configUrl: "https://cdn.example/config.json",
      }),
    ).toThrow(/createVoiceThereWidgetAsync/);
  });

  it("mounts the production legacy snippet without configUrl", () => {
    // Production dashboard (v0.1.4) still emits:
    // import { createVoiceThereWidget } from "https://esm.sh/@voicethere/client@0.7.29/embed"
    // createVoiceThereWidget({ apiBase, projectId, clientKey, mode: "chat" })
    expect(() =>
      createVoiceThereWidget({
        apiBase: "https://sessions.voicethere.io/v1",
        projectId: "p",
        clientKey: "key",
        mode: BrowserSessionModeType.Chat,
        mount: mount as unknown as HTMLElement,
      }),
    ).not.toThrow();

    const root = findWidgetRoot(mount);
    expect(root).toBeDefined();
    const connectBtn = findButtonByText(mount, "Connect");
    expect(connectBtn).toBeDefined();
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
