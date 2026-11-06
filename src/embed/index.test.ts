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
  WIDGET_KEY_HASH_FIXTURE_HEX,
  WIDGET_KEY_HASH_FIXTURE_RAW,
  widgetBootstrapCdnUrl,
  widgetKeyMapUrl,
  widgetProjectBootstrapUrl,
  DEFAULT_WIDGET_CDN_BASE,
} from "./index.js";
import { WIDGET_PRESET_IDS } from "./config.js";
import { formatWidgetTime } from "./index.js";

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
  addEventListener: (type: string, handler: (event: never) => void) => void;
  click: () => void;
  contains: (node: unknown) => boolean;
  clickListeners: Array<(event: { target?: unknown }) => void>;
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
    addEventListener(type: string, handler: (event: never) => void) {
      if (type === "keydown") {
        this.onkeydown = handler as (event: { key: string }) => void;
      }
      if (type === "click") {
        this.clickListeners.push(handler as never);
      }
    },
    clickListeners: [],
    contains(node: unknown): boolean {
      if (node === this) return true;
      return this.children.some((c: MockElement) => c.contains(node));
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
let sessionStorageData: Map<string, string>;
let localStorageData: Map<string, string>;

beforeEach(() => {
  createdElements = [];
  mount = createMockElement("div");
  sessionStorageData = new Map<string, string>();
  localStorageData = new Map<string, string>();

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

  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => sessionStorageData.get(key) ?? null,
    setItem: (key: string, value: string) => {
      sessionStorageData.set(key, value);
    },
    removeItem: (key: string) => {
      sessionStorageData.delete(key);
    },
    clear: () => {
      sessionStorageData.clear();
    },
  });

  vi.stubGlobal("localStorage", {
    getItem: (key: string) => localStorageData.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageData.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageData.delete(key);
    },
    clear: () => {
      localStorageData.clear();
    },
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
    setMicMuted: vi.fn(),
    isMicMuted: () => false,
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

  describe("key-only CDN bootstrap", () => {
    const bootstrapProjectId = "11111111-1111-4111-8111-111111111111";

    const keyMapUrl = widgetKeyMapUrl(
      DEFAULT_WIDGET_CDN_BASE,
      WIDGET_KEY_HASH_FIXTURE_HEX,
    );
    const projectUrl = widgetProjectBootstrapUrl(
      DEFAULT_WIDGET_CDN_BASE,
      "w_test",
    );
    const legacyUrl = widgetBootstrapCdnUrl(
      DEFAULT_WIDGET_CDN_BASE,
      WIDGET_KEY_HASH_FIXTURE_HEX,
    );
    const pointerKey = `vt:kmap:${WIDGET_KEY_HASH_FIXTURE_HEX}`;

    type CdnRoute = { status?: number; body?: unknown; raw?: string };

    /** Serve CDN GETs by URL; unlisted URLs answer 404. */
    function routeCdn(routes: Record<string, CdnRoute>) {
      vi.mocked(fetch).mockImplementation((async (input: unknown) => {
        const route = routes[String(input)] ?? { status: 404, body: {} };
        const status = route.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => route.raw ?? JSON.stringify(route.body ?? {}),
        } as Response;
      }) as typeof fetch);
    }

    const pointerRoute: CdnRoute = { body: { v: 1, public_id: "w_test" } };

    function fetchedUrls(): string[] {
      return vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
    }

    function mockBootstrapResponse(
      body: Record<string, unknown>,
      status = 200,
      cdnBase = DEFAULT_WIDGET_CDN_BASE,
    ) {
      routeCdn({
        [widgetKeyMapUrl(cdnBase, WIDGET_KEY_HASH_FIXTURE_HEX)]: pointerRoute,
        [widgetProjectBootstrapUrl(cdnBase, "w_test")]: { status, body },
      });
    }

    const widgetAppearance = {
      v: 1,
      preset: "rounded-card",
      launcherLabel: "Help",
      greeting: "Hello from bootstrap",
      position: "bottom-left",
      mode: "chat",
    };

    const publishedBootstrap = {
      project_id: bootstrapProjectId,
      api_base: "https://sessions.voicethere.io/v1",
      public_id: "w_test",
      published: true,
      published_revision: 1,
      widget: widgetAppearance,
    };

    it("boots from bootstrap by client key hash with widget appearance", async () => {
      mockBootstrapResponse(publishedBootstrap);

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        mount: mount as unknown as HTMLElement,
      });

      expect(fetchedUrls()).toEqual([keyMapUrl, projectUrl]);
      expect(fetch).toHaveBeenCalledWith(
        projectUrl,
        expect.objectContaining({ credentials: "omit" }),
      );
      for (const call of vi.mocked(fetch).mock.calls) {
        expect((call[1] as RequestInit | undefined)?.headers).toBeUndefined();
      }
      expect(localStorageData.get(pointerKey)).toBe("w_test");

      const root = findWidgetRoot(mount);
      expect(root?.dataset.voicetherePreset).toBe("rounded-card");
      expect(root?.dataset.voicetherePosition).toBe("bottom-left");

      const connectBtn = findButtonByText(mount, "Connect");
      connectBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: bootstrapProjectId,
          apiBase: "https://sessions.voicethere.io/v1",
          headers: { Authorization: `Bearer ${WIDGET_KEY_HASH_FIXTURE_RAW}` },
        }),
      );
    });

    it("uses built-in defaults when bootstrap widget is null", async () => {
      mockBootstrapResponse({
        ...publishedBootstrap,
        widget: null,
        published: false,
        published_revision: 0,
      });

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        mount: mount as unknown as HTMLElement,
      });

      const root = findWidgetRoot(mount);
      expect(root?.dataset.voicetherePreset).toBe("pill-dark");
      const launcher = root!.children.find((c) => c.tagName === "BUTTON");
      expect(launcher?.textContent).toBe("Chat");
    });

    it("inline options override bootstrap identity and appearance", async () => {
      mockBootstrapResponse(publishedBootstrap);

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        projectId: "inline-project",
        apiBase: "https://inline.example/v1",
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

    it("uses staging CDN when apiBase is staging sessions host", async () => {
      mockBootstrapResponse(
        {
          ...publishedBootstrap,
          api_base: "https://sessions.voicethere.dev/v1",
        },
        200,
        "https://cdn.voicethere.dev",
      );

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        apiBase: "https://sessions.voicethere.dev/v1",
        mount: mount as unknown as HTMLElement,
      });

      expect(fetch).toHaveBeenCalledWith(
        widgetProjectBootstrapUrl("https://cdn.voicethere.dev", "w_test"),
        expect.any(Object),
      );
    });

    it("throws when bootstrap fails and inline bootstrap is missing", async () => {
      mockBootstrapResponse({}, 404);

      await expect(
        createVoiceThereWidgetAsync({
          clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
          mount: mount as unknown as HTMLElement,
        }),
      ).rejects.toThrow(/requires projectId/);
    });

    it("mounts from inline options when bootstrap fetch fails", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));

      await createVoiceThereWidgetAsync({
        clientKey: "key",
        projectId: "inline-project",
        apiBase: "https://inline.example/v1",
        mount: mount as unknown as HTMLElement,
      });

      expect(warnSpy).toHaveBeenCalled();
      expect(findWidgetRoot(mount)).toBeDefined();
      warnSpy.mockRestore();
    });

    it("sessionStorage cache skips a second bootstrap GET", async () => {
      mockBootstrapResponse(publishedBootstrap);

      const opts = {
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        mount: mount as unknown as HTMLElement,
      };

      await createVoiceThereWidgetAsync(opts);
      await createVoiceThereWidgetAsync(opts);

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("uses a cached pointer and only fetches the project bootstrap", async () => {
      localStorageData.set(pointerKey, "w_test");
      mockBootstrapResponse(publishedBootstrap);

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        mount: mount as unknown as HTMLElement,
      });

      expect(fetchedUrls()).toEqual([projectUrl]);
    });

    it("falls back to the legacy per-key URL when the pointer is 404", async () => {
      routeCdn({ [legacyUrl]: { body: publishedBootstrap } });

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        mount: mount as unknown as HTMLElement,
      });

      expect(fetchedUrls()).toEqual([keyMapUrl, legacyUrl]);
      expect(localStorageData.has(pointerKey)).toBe(false);
      const connectBtn = findButtonByText(mount, "Connect");
      connectBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: bootstrapProjectId }),
      );
    });

    it("clears the pointer and uses legacy when the project bootstrap is 404", async () => {
      localStorageData.set(pointerKey, "w_test");
      routeCdn({ [legacyUrl]: { body: publishedBootstrap } });

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        mount: mount as unknown as HTMLElement,
      });

      expect(fetchedUrls()).toEqual([projectUrl, legacyUrl]);
      expect(localStorageData.has(pointerKey)).toBe(false);
    });

    it("falls back to legacy when the pointer answers 403", async () => {
      routeCdn({
        [keyMapUrl]: { status: 403 },
        [legacyUrl]: { body: publishedBootstrap },
      });

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        mount: mount as unknown as HTMLElement,
      });

      expect(fetchedUrls()).toEqual([keyMapUrl, legacyUrl]);
      expect(localStorageData.has(pointerKey)).toBe(false);
    });

    it("clears the pointer and uses legacy when the project bootstrap is 403", async () => {
      localStorageData.set(pointerKey, "w_test");
      routeCdn({
        [projectUrl]: { status: 403 },
        [legacyUrl]: { body: publishedBootstrap },
      });

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        mount: mount as unknown as HTMLElement,
      });

      expect(fetchedUrls()).toEqual([projectUrl, legacyUrl]);
      expect(localStorageData.has(pointerKey)).toBe(false);
    });

    it("uses defaults when pointer and legacy are both 404", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      routeCdn({});

      await expect(
        createVoiceThereWidgetAsync({
          clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
          mount: mount as unknown as HTMLElement,
        }),
      ).rejects.toThrow(/requires projectId/);
      expect(fetchedUrls()).toEqual([keyMapUrl, legacyUrl]);

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        projectId: "inline-project",
        apiBase: "https://inline.example/v1",
        mount: mount as unknown as HTMLElement,
      });
      expect(findWidgetRoot(mount)?.dataset.voicetherePreset).toBe("pill-dark");
      warnSpy.mockRestore();
    });

    it.each([
      ["wrong version", { v: 2, public_id: "w_test" }],
      ["bad public_id", { v: 1, public_id: "../etc" }],
      ["missing public_id", { v: 1 }],
    ])("treats an invalid pointer (%s) like 404", async (_label, body) => {
      routeCdn({
        [keyMapUrl]: { body },
        [legacyUrl]: { body: publishedBootstrap },
      });

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        mount: mount as unknown as HTMLElement,
      });

      expect(fetchedUrls()).toEqual([keyMapUrl, legacyUrl]);
      expect(localStorageData.has(pointerKey)).toBe(false);
    });

    it("treats non-JSON pointer bodies like 404", async () => {
      routeCdn({
        [keyMapUrl]: { raw: "<html>" },
        [legacyUrl]: { body: publishedBootstrap },
      });

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        mount: mount as unknown as HTMLElement,
      });

      expect(fetchedUrls()).toEqual([keyMapUrl, legacyUrl]);
    });

    it("does not mask a 5xx on the project bootstrap with legacy", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      localStorageData.set(pointerKey, "w_test");
      routeCdn({
        [projectUrl]: { status: 503 },
        [legacyUrl]: { body: publishedBootstrap },
      });

      await expect(
        createVoiceThereWidgetAsync({
          clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
          mount: mount as unknown as HTMLElement,
        }),
      ).rejects.toThrow(/requires projectId/);
      expect(fetchedUrls()).toEqual([projectUrl]);
      expect(localStorageData.get(pointerKey)).toBe("w_test");
      warnSpy.mockRestore();
    });

    it("still resolves when localStorage and sessionStorage throw", async () => {
      const boom = () => {
        throw new Error("storage blocked");
      };
      vi.stubGlobal("localStorage", {
        getItem: boom,
        setItem: boom,
        removeItem: boom,
      });
      vi.stubGlobal("sessionStorage", {
        getItem: boom,
        setItem: boom,
        removeItem: boom,
      });
      mockBootstrapResponse(publishedBootstrap);

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        mount: mount as unknown as HTMLElement,
      });

      expect(fetchedUrls()).toEqual([keyMapUrl, projectUrl]);
      expect(findWidgetRoot(mount)?.dataset.voicetherePreset).toBe(
        "rounded-card",
      );
    });

    it.each([401, 403])(
      "clears the cached pointer when session creation is rejected with %i",
      async (httpStatus) => {
        mockBootstrapResponse(publishedBootstrap);
        startSession.mockResolvedValueOnce({
          ok: false,
          code: "HTTP_ERROR",
          message: `POST /sessions failed (${httpStatus}): denied`,
          httpStatus,
        });

        await createVoiceThereWidgetAsync({
          clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
          mount: mount as unknown as HTMLElement,
        });
        expect(localStorageData.get(pointerKey)).toBe("w_test");

        findButtonByText(mount, "Connect")!.click();
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(localStorageData.has(pointerKey)).toBe(false);
      },
    );

    it("keeps the cached pointer when session creation fails with 500", async () => {
      mockBootstrapResponse(publishedBootstrap);
      startSession.mockResolvedValueOnce({
        ok: false,
        code: "HTTP_ERROR",
        message: "POST /sessions failed (500): boom",
        httpStatus: 500,
      });

      await createVoiceThereWidgetAsync({
        clientKey: WIDGET_KEY_HASH_FIXTURE_RAW,
        mount: mount as unknown as HTMLElement,
      });
      findButtonByText(mount, "Connect")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(localStorageData.get(pointerKey)).toBe("w_test");
    });
  });
});

describe("createVoiceThereWidget connection recovery", () => {
  it("widget shows the reconnecting message on interrupted and the lost message on lost", async () => {
    createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mode: BrowserSessionModeType.Voice,
      mount: mount as unknown as HTMLElement,
    });
    const connectBtn = findButtonByText(mount, "Connect")!;
    connectBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const session = await connectBrowserSession.mock.results[0]!.value;
    const { onConnectionStatus } = connectBrowserSession.mock.calls[0]![0] as {
      onConnectionStatus: (status: Record<string, unknown>) => void;
    };
    const statusLine = createdElements.find((el) =>
      el.classList.contains(WIDGET_CSS_CLASSES.status),
    )!;
    const [spinner, text] = statusLine.children;
    const base = {
      ready: false,
      phase: "connecting",
      signalingJoined: true,
      peerConnectionState: "disconnected",
      inboundAudioTrack: true,
      outboundAudioTrack: true,
      controlChannelOpen: true,
      syncChannelOpen: true,
    };

    onConnectionStatus({
      ...base,
      recovery: {
        state: "interrupted",
        sinceMs: 2000,
        message: "Connection lost. Reconnecting…",
      },
    });
    expect(text!.textContent).toBe("Connection lost. Reconnecting…");
    expect(spinner!.style.display).toBe("inline-block");

    onConnectionStatus({
      ...base,
      phase: "closed",
      recovery: {
        state: "lost",
        reason: "WEBRTC_RECONNECT_EXHAUSTED",
        message:
          "The connection could not be restored. Please start a new conversation.",
      },
    });
    expect(text!.textContent).toBe(
      "The connection could not be restored. Please start a new conversation.",
    );
    expect(spinner!.style.display).toBe("none");
    expect(session.disconnect).toHaveBeenCalled();
    // Start button is usable again for a new conversation.
    expect(connectBtn.textContent).toBe("Connect");
  });
});

describe("createVoiceThereWidget spoken text reveal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const connectAndGetHandler = async (extra: {
    streamSpokenText?: boolean;
  }) => {
    const widget = createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mode: BrowserSessionModeType.Voice,
      mount: mount as unknown as HTMLElement,
      ...extra,
    });
    findButtonByText(mount, "Connect")!.click();
    await vi.advanceTimersByTimeAsync(0);
    const onControlMessage = (
      connectBrowserSession.mock.calls[0]![0] as {
        onControlMessage: (payload: Record<string, unknown>) => void;
      }
    ).onControlMessage;
    return { widget, onControlMessage };
  };
  const bubbleTexts = () =>
    createdElements
      .filter((el) => el.textContent.startsWith("One"))
      .map((el) => el.textContent);

  it("is on by default: a spoken turn is paced word by word", async () => {
    const { onControlMessage } = await connectAndGetHandler({});
    onControlMessage({
      type: "assistant_delta",
      turnId: "t1",
      text: "One two three.",
      spoken: true,
    });
    onControlMessage({ type: "speech_event", event: "agent_speaking_start" });
    expect(bubbleTexts()).toEqual(["One"]);
    await vi.advanceTimersByTimeAsync(330);
    expect(bubbleTexts()).toEqual(["One two"]);
  });

  it("default: agent_speak after a spoken done holds the text until agent_speaking_start", async () => {
    const { onControlMessage } = await connectAndGetHandler({});
    const speakText = "One two three.";
    const shownAlone = () =>
      createdElements.some((el) => el.textContent === speakText);
    onControlMessage({
      type: "assistant_delta",
      turnId: "t1",
      text: "One two three.",
      spoken: true,
    });
    onControlMessage({
      type: "assistant_done",
      turnId: "t1",
      text: "One two three.",
      spoken: true,
      status: "completed",
    });
    onControlMessage({ type: "agent_speak", text: speakText });
    expect(shownAlone()).toBe(false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(bubbleTexts()).toEqual([]);
    expect(shownAlone()).toBe(false);
    onControlMessage({ type: "speech_event", event: "agent_speaking_start" });
    expect(bubbleTexts()).toEqual(["One"]);
  });

  it("a spoken reveal updates the text and keeps the bubble's time", async () => {
    const { onControlMessage } = await connectAndGetHandler({});
    onControlMessage({
      type: "assistant_delta",
      turnId: "t1",
      text: "One two three four five.",
      spoken: true,
    });
    onControlMessage({ type: "speech_event", event: "agent_speaking_start" });
    const turnBubbles = () =>
      createdElements.filter((el) => el.attrs["data-voicethere-turn"] === "t1");
    expect(turnBubbles()).toHaveLength(1);
    const timeOf = (b: MockElement) =>
      b.children.filter((c) => c.tagName === "TIME");
    const firstDatetime = timeOf(turnBubbles()[0]!)[0]!.attrs.datetime;
    expect(firstDatetime).toBeTruthy();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(turnBubbles()).toHaveLength(1);
    const times = timeOf(turnBubbles()[0]!);
    expect(times).toHaveLength(1);
    expect(times[0]!.attrs.datetime).toBe(firstDatetime);
    const textEl = turnBubbles()[0]!.children.find((c) =>
      c.classList.contains(WIDGET_CSS_CLASSES.msgText),
    )!;
    expect(textEl.textContent).toBe("One two three four five.");
  });

  it("streamSpokenText: false paces nothing: a spoken turn is shown in full at once", async () => {
    const { onControlMessage } = await connectAndGetHandler({
      streamSpokenText: false,
    });
    onControlMessage({
      type: "assistant_delta",
      turnId: "t1",
      text: "One two three.",
      spoken: true,
    });
    expect(bubbleTexts()).toEqual(["One two three."]);
  });

  it("default: a plain chat_reply is shown in full synchronously, with no timer advance", async () => {
    const { onControlMessage } = await connectAndGetHandler({});
    onControlMessage({ type: "chat_reply", text: "One two three four." });
    expect(bubbleTexts()).toEqual(["One two three four."]);
  });

  it("streamSpokenText: true paces a plain chat_reply too", async () => {
    const { onControlMessage } = await connectAndGetHandler({
      streamSpokenText: true,
    });
    onControlMessage({
      type: "chat_reply",
      text: "One two three four.",
      stream: true,
    });
    expect(bubbleTexts()).toEqual([]);
    onControlMessage({ type: "speech_event", event: "agent_speaking_start" });
    expect(bubbleTexts()).toEqual(["One"]);
  });

  it("true paces spoken turns as well", async () => {
    const { onControlMessage } = await connectAndGetHandler({
      streamSpokenText: true,
    });
    onControlMessage({
      type: "assistant_delta",
      turnId: "t1",
      text: "One two three.",
      spoken: true,
    });
    onControlMessage({ type: "speech_event", event: "agent_speaking_start" });
    expect(bubbleTexts()).toEqual(["One"]);
  });

  it("updateConfig({ streamSpokenText: false }) mid-reveal disposes the caption without leaking timers, then shows spoken text at once", async () => {
    const { widget, onControlMessage } = await connectAndGetHandler({});
    onControlMessage({
      type: "assistant_delta",
      turnId: "t1",
      text: "One two three.",
      spoken: true,
    });
    onControlMessage({ type: "speech_event", event: "agent_speaking_start" });
    expect(bubbleTexts()).toEqual(["One"]);
    const timersBefore = vi.getTimerCount();
    widget.updateConfig({ streamSpokenText: false });
    expect(vi.getTimerCount()).toBeLessThan(timersBefore);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bubbleTexts()).toEqual(["One"]);
    onControlMessage({
      type: "assistant_delta",
      turnId: "t2",
      text: "Four five.",
      spoken: true,
    });
    const texts = createdElements.map((el) => el.textContent);
    expect(texts).toContain("Four five.");
  });
});

describe("createVoiceThereWidget agent links", () => {
  const connectAndGetContent = async (extra: Record<string, unknown> = {}) => {
    const widget = createVoiceThereWidget({
      ...extra,
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mode: BrowserSessionModeType.Voice,
      mount: mount as unknown as HTMLElement,
    });
    findButtonByText(mount, "Connect")!.click();
    await vi.waitFor(() => expect(connectBrowserSession).toHaveBeenCalled());
    const onAgentContent = (
      connectBrowserSession.mock.calls[0]![0] as {
        onAgentContent: (event: Record<string, unknown>) => void;
      }
    ).onAgentContent;
    return { widget, onAgentContent };
  };
  const anchors = () => createdElements.filter((el) => el.tagName === "A");
  const labelOf = (a: MockElement) => a.children[1]!.textContent;

  it("renders an https link as a new-tab anchor with its label", async () => {
    const { onAgentContent } = await connectAndGetContent();
    onAgentContent({
      turnId: "t1",
      spoken: true,
      content: {
        kind: "link",
        url: "https://app.voicethere.dev/docs/pricing",
        label: "Pricing",
      },
    });
    const links = anchors();
    expect(links).toHaveLength(1);
    const a = links[0] as unknown as Record<string, string>;
    expect(a.href).toBe("https://app.voicethere.dev/docs/pricing");
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
    expect(labelOf(a)).toBe("Pricing");
  });

  const evilLink = {
    turnId: "t1",
    spoken: false,
    content: { kind: "link", url: "https://evil.example/x", label: "Evil" },
  };
  const linkBubbleOf = () =>
    createdElements.find((el) => el.attrs["data-voicethere-kind"] === "link")!;
  const expectPlainText = () => {
    expect(anchors()).toHaveLength(0);
    const bubble = linkBubbleOf();
    expect(bubble.attrs["data-voicethere-kind"]).toBe("link");
    expect(bubble.attrs["data-voicethere-turn"]).toBe("t1");
    const row = bubble.children.find((c) => c.children.length === 2)!;
    expect(row.tagName).toBe("SPAN");
    expect(row.children[1]!.textContent).toBe("Evil");
    expect(bubble.style.cursor).not.toBe("pointer");
  };

  it("isLinkAllowed false renders the link as text", async () => {
    const isLinkAllowed = vi.fn(() => false);
    const { onAgentContent } = await connectAndGetContent({ isLinkAllowed });
    onAgentContent(evilLink);
    expect(isLinkAllowed).toHaveBeenCalledTimes(1);
    expect((isLinkAllowed.mock.calls[0] as unknown[])[0]).toBeInstanceOf(URL);
    expectPlainText();
  });

  it("a throwing isLinkAllowed blocks the link", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { onAgentContent } = await connectAndGetContent({
      isLinkAllowed: () => {
        throw new Error("boom");
      },
    });
    onAgentContent(evilLink);
    expectPlainText();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("isLinkAllowed true keeps the clickable link", async () => {
    const { onAgentContent } = await connectAndGetContent({
      isLinkAllowed: () => true,
    });
    onAgentContent(evilLink);
    expect(anchors()).toHaveLength(1);
  });

  it("shows the URL when there is no label and never renders another scheme", async () => {
    const { onAgentContent } = await connectAndGetContent();
    onAgentContent({
      turnId: "t1",
      spoken: false,
      content: { kind: "link", url: "javascript:alert(1)" },
    });
    onAgentContent({
      turnId: "t1",
      spoken: false,
      content: { kind: "link", url: "http://example.com/x" },
    });
    expect(anchors()).toHaveLength(0);
    onAgentContent({
      turnId: "t1",
      spoken: false,
      content: { kind: "link", url: "https://example.com/x" },
    });
    expect(anchors().map((a) => labelOf(a))).toEqual(["example.com/x"]);
  });
});

describe("createVoiceThereWidget bubbles, times, inline display and session provider", () => {
  const STARTED_OK = {
    ok: true as const,
    jobId: "j",
    buildId: null,
    credentials: {
      session_id: "s",
      mode: "chat",
      room_id: "r",
      join_token: "j",
      signaling_url: "ws://127.0.0.1:8080/ws",
      ice_servers: [],
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  };

  const transcriptEl = () =>
    createdElements.find((el) =>
      el.classList.contains(WIDGET_CSS_CLASSES.transcript),
    )!;
  const bubbles = () =>
    transcriptEl().children.filter((c) =>
      c.classList.contains(WIDGET_CSS_CLASSES.msg),
    );
  const attr = (el: MockElement, name: string) => el.attrs[name];
  const timeOf = (bubble: MockElement) =>
    bubble.children.find((c) => c.tagName === "TIME");

  const connect = async (
    extra: Record<string, unknown> = {},
    callIndex = 0,
  ) => {
    const widget = createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mode: BrowserSessionModeType.Chat,
      mount: mount as unknown as HTMLElement,
      ...extra,
    });
    findButtonByText(mount, "Connect")!.click();
    await vi.waitFor(() =>
      expect(connectBrowserSession).toHaveBeenCalledTimes(callIndex + 1),
    );
    const opts = connectBrowserSession.mock.calls[callIndex]![0] as {
      onControlMessage: (p: Record<string, unknown>) => void;
      onAgentContent: (e: Record<string, unknown>) => void;
      onAgentFiller: (e: { turnId: string; text: string }) => void;
    };
    return { widget, ...opts };
  };

  it("inline display has no launcher, fills the mount, and open/close do nothing", async () => {
    const widget = createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      display: "inline",
      mount: mount as unknown as HTMLElement,
    });
    const root = findWidgetRoot(mount)!;
    expect(findLauncher(root)).toBeUndefined();
    expect(attr(root, "data-voicethere-display")).toBe("inline");
    expect(root.style.position).toBe("relative");
    expect(root.style.width).toBe("100%");
    expect(root.style.height).toBe("100%");
    const panel = findPanel(root)!;
    expect(panel.style.display).toBe("flex");
    expect(panel.style.width).toBe("100%");
    expect(panel.style.height).toBe("100%");
    widget.close();
    expect(panel.style.display).toBe("flex");
    widget.open();
    expect(panel.style.display).toBe("flex");
    widget.destroy();
  });

  it("launcher display (default) keeps the launcher and a closed panel", () => {
    createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mount: mount as unknown as HTMLElement,
    });
    const root = findWidgetRoot(mount)!;
    expect(findLauncher(root)).toBeDefined();
    expect(findPanel(root)!.style.display).toBe("none");
    expect(root.style.position).toBe("fixed");
  });

  it("uses the startSession provider and never sends the clientKey request", async () => {
    const provider = vi.fn(async (_signal: AbortSignal) => STARTED_OK);
    await connect({ clientKey: undefined, startSession: provider });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    expect(startSession).not.toHaveBeenCalled();
    expect(
      (connectBrowserSession.mock.calls[0]![0] as { credentials: unknown })
        .credentials,
    ).toBe(STARTED_OK.credentials);
  });

  it("a provider that rejects or returns ok:false shows the message and does not connect", async () => {
    const rejecting = vi.fn(async () => {
      throw new Error("demo busy");
    });
    createVoiceThereWidget({
      startSession: rejecting,
      mount: mount as unknown as HTMLElement,
    });
    findButtonByText(mount, "Connect")!.click();
    await vi.waitFor(() => expect(rejecting).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(createdElements.some((el) => el.textContent === "demo busy")).toBe(
        true,
      ),
    );
    expect(connectBrowserSession).not.toHaveBeenCalled();
  });

  it("requires clientKey or a startSession provider", () => {
    expect(() =>
      createVoiceThereWidget({ mount: mount as unknown as HTMLElement }),
    ).toThrow(/clientKey or a startSession provider/);
  });

  it("shows a time on every non-system bubble by default, with a datetime", async () => {
    const { onControlMessage } = await connect();
    onControlMessage({ type: "chat_reply", text: "Hello", turnId: "t1" });
    const [reply] = bubbles();
    const time = timeOf(reply!)!;
    expect(time).toBeDefined();
    expect(time.style.display).toBe("block");
    expect(Number.isNaN(Date.parse(time.attrs.datetime!))).toBe(false);
    expect(time.textContent).toMatch(/\d/);
  });

  it("theme.chat.timestamps.show false hides the times", async () => {
    const { onControlMessage } = await connect({
      theme: { chat: { timestamps: { show: false } } },
    });
    onControlMessage({ type: "chat_reply", text: "Hello" });
    expect(timeOf(bubbles()[0]!)!.style.display).toBe("none");
  });

  it("timestamps colour applies, and updateConfig re-renders existing times", async () => {
    const { widget, onControlMessage } = await connect({
      theme: { chat: { timestamps: { color: "#ff0000" } } },
    });
    onControlMessage({ type: "chat_reply", text: "Hello" });
    const time = timeOf(bubbles()[0]!)!;
    expect(time.style.color).toBe("#ff0000");
    const datetime = time.attrs.datetime;
    widget.updateConfig({ theme: { chat: { timestamps: { show: false } } } });
    expect(time.style.display).toBe("none");
    expect(time.attrs.datetime).toBe(datetime);
  });

  it("formatWidgetTime renders 12h and 24h", () => {
    const at = new Date(2026, 10, 3, 15, 5);
    expect(formatWidgetTime(at, "12h", "en-US")).toMatch(/^3:05\s?PM$/i);
    expect(formatWidgetTime(at, "24h", "en-US")).toBe("15:05");
    expect(formatWidgetTime(new Date(2026, 10, 3, 0, 5), "24h", "en-US")).toBe(
      "00:05",
    );
    expect(formatWidgetTime(at, "auto", "en-US")).toMatch(/3:05\s?PM/i);
  });

  it("a link that arrives before the reply stays above the reply bubble", async () => {
    const { onControlMessage, onAgentContent } = await connect();
    onAgentContent({
      turnId: "t1",
      spoken: false,
      content: { kind: "link", url: "https://example.com/pricing" },
    });
    const linkBubble = bubbles()[0]!;
    onControlMessage({ type: "chat_reply", text: "Here you go", turnId: "t1" });
    const after = bubbles();
    expect(after[0]).toBe(linkBubble);
    expect(attr(after[0]!, "data-voicethere-kind")).toBe("link");
    expect(attr(after[1]!, "data-voicethere-kind")).toBe("reply");
  });

  it("a filler bubble comes before the reply bubble and carries the filler kind", async () => {
    const { onControlMessage, onAgentFiller } = await connect();
    onAgentFiller({ turnId: "t1", text: "One moment" });
    onControlMessage({ type: "chat_reply", text: "Done", turnId: "t1" });
    const [filler, reply] = bubbles();
    expect(attr(filler!, "data-voicethere-kind")).toBe("filler");
    expect(attr(filler!, "data-voicethere-turn")).toBe("t1");
    expect(filler!.classList.contains(WIDGET_CSS_CLASSES.msgFiller)).toBe(true);
    expect(attr(reply!, "data-voicethere-kind")).toBe("reply");
  });

  it("sets role, kind and turn attributes on every bubble kind", async () => {
    const { onControlMessage, onAgentContent, onAgentFiller } = await connect({
      greeting: "Hi there",
    });
    onAgentFiller({ turnId: "t1", text: "One moment" });
    onAgentContent({
      turnId: "t1",
      spoken: false,
      content: { kind: "link", url: "https://example.com/x" },
    });
    onControlMessage({ type: "chat_reply", text: "Reply", turnId: "t1" });
    onControlMessage({
      type: "speech_event",
      event: "stt_final",
      text: "caller words",
    });
    const input = createdElements.find((el) => el.tagName === "INPUT") as
      (MockElement & { value?: string }) | undefined;
    input!.value = "typed";
    input!.onkeydown?.({ key: "Enter" });
    const seen = bubbles().map((b) => [
      attr(b, "data-voicethere-role"),
      attr(b, "data-voicethere-kind"),
      attr(b, "data-voicethere-turn"),
    ]);
    expect(seen).toEqual([
      ["system", "greeting", undefined],
      ["incoming", "filler", "t1"],
      ["incoming", "link", "t1"],
      ["incoming", "reply", "t1"],
      ["outgoing", "speech", undefined],
      ["outgoing", "chat", undefined],
    ]);
    // System bubbles carry no time; all others do.
    expect(bubbles().map((b) => timeOf(b) !== undefined)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("a click on the link bubble outside the anchor opens the link once", async () => {
    vi.stubGlobal(
      "Node",
      class {
        static [Symbol.hasInstance](v: unknown) {
          return typeof v === "object" && v !== null;
        }
      },
    );
    const { onAgentContent } = await connect();
    onAgentContent({
      turnId: "t1",
      spoken: false,
      content: { kind: "link", url: "https://example.com/x", label: "X" },
    });
    const bubble = bubbles()[0]!;
    const anchor = bubble.children.find((c) => c.tagName === "A")!;
    const clickSpy = vi.fn();
    anchor.click = clickSpy;
    expect(bubble.clickListeners).toHaveLength(1);
    bubble.clickListeners[0]!({ target: bubble });
    expect(clickSpy).toHaveBeenCalledTimes(1);
    bubble.clickListeners[0]!({ target: anchor.children[1] });
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("a user stt_final bubble renders on the outgoing side, agent speech stays incoming", async () => {
    const { onControlMessage } = await connect();
    onControlMessage({
      type: "speech_event",
      event: "stt_final",
      text: "caller words",
    });
    onControlMessage({
      type: "speech_event",
      event: "agent_speech",
      text: "agent words",
    });
    const [user, agent] = bubbles();
    expect(attr(user!, "data-voicethere-role")).toBe("outgoing");
    expect(attr(user!, "data-voicethere-kind")).toBe("speech");
    expect(user!.classList.contains(WIDGET_CSS_CLASSES.msgOutgoing)).toBe(true);
    expect(user!.style.alignSelf).toBe("flex-end");
    expect(timeOf(user!)).toBeDefined();
    expect(attr(agent!, "data-voicethere-role")).toBe("incoming");
    expect(attr(agent!, "data-voicethere-kind")).toBe("reply");
  });

  it("a link bubble is a button: icon plus label, https only, new tab", async () => {
    const { onAgentContent } = await connect();
    onAgentContent({
      turnId: "t1",
      spoken: false,
      content: { kind: "link", url: "https://example.com/", label: " Docs " },
    });
    const bubble = bubbles()[0]!;
    const anchor = bubble.children.find((c) => c.tagName === "A")!;
    expect(anchor.children).toHaveLength(2);
    expect(
      (anchor.children[0] as unknown as { innerHTML: string }).innerHTML,
    ).toContain("<svg");
    expect(anchor.children[1]!.textContent).toBe("Docs");
    expect(bubble.style.cursor).toBe("pointer");
    expect(timeOf(bubble)).toBeDefined();
  });
});

describe("createVoiceThereWidget host hooks", () => {
  const connect = async (extra: Record<string, unknown> = {}) => {
    const widget = createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mode: BrowserSessionModeType.Chat,
      mount: mount as unknown as HTMLElement,
      ...extra,
    });
    findButtonByText(mount, "Connect")!.click();
    await vi.waitFor(() => expect(connectBrowserSession).toHaveBeenCalled());
    const session = await connectBrowserSession.mock.results[0]!.value;
    // Let waitForConnected and the code after it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const opts = connectBrowserSession.mock.calls[0]![0] as Record<
      string,
      (...args: unknown[]) => void
    >;
    return { widget, session, opts };
  };

  it("onSession gets the live session once per connect, again on reconnect, and null when it ends", async () => {
    const onSession = vi.fn();
    const { session, opts } = await connect({ onSession });
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenLastCalledWith(session);

    opts.onReconnected!(1);
    expect(onSession).toHaveBeenCalledTimes(2);
    expect(onSession).toHaveBeenLastCalledWith(session);

    findButtonByText(mount, "Disconnect")!.click();
    expect(onSession).toHaveBeenCalledTimes(3);
    expect(onSession).toHaveBeenLastCalledWith(null);
  });

  it("onSessionEnd fires once with reason closed on disconnect and not again on destroy", async () => {
    const onSessionEnd = vi.fn();
    const { widget } = await connect({ onSessionEnd });
    findButtonByText(mount, "Disconnect")!.click();
    widget.destroy();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledWith({ reason: "closed" });
  });

  it("onSessionEnd fires once with the session error, and a later lost connection does not repeat it", async () => {
    const onSessionEnd = vi.fn();
    const { opts } = await connect({ onSessionEnd });
    const event = {
      type: "session_error",
      code: "SESSION_IDLE_TIMEOUT",
      message: "Session ended: idle",
      session_id: "s",
      recoverable: false,
    };
    opts.onSessionError!(event);
    opts.onConnectionStatus!({ recovery: { state: "lost", message: "gone" } });
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledWith({
      reason: "error",
      error: event,
    });
    const statusLine = createdElements.find((el) =>
      el.classList.contains(WIDGET_CSS_CLASSES.status),
    )!;
    expect(statusLine.children[1]!.textContent).toBe("gone");
  });

  it("onSessionEnd reports a lost connection as an error", async () => {
    const onSessionEnd = vi.fn();
    const { opts } = await connect({ onSessionEnd });
    const recovery = { state: "lost", message: "gone" };
    opts.onConnectionStatus!({ recovery });
    expect(onSessionEnd).toHaveBeenCalledWith({
      reason: "error",
      error: recovery,
    });
  });

  it("onAgentAudioTrack and onControlMessage receive the same arguments the session gave", async () => {
    const onAgentAudioTrack = vi.fn();
    const onControlMessage = vi.fn();
    const { opts } = await connect({ onAgentAudioTrack, onControlMessage });
    const track = { kind: "audio" };
    opts.onAgentAudioTrack!(track);
    expect(onAgentAudioTrack).toHaveBeenCalledTimes(1);
    expect(onAgentAudioTrack).toHaveBeenCalledWith(track);

    const message = { type: "chat_reply", text: "hi", turnId: "t1" };
    opts.onControlMessage!(message);
    expect(onControlMessage).toHaveBeenCalledTimes(1);
    expect(onControlMessage).toHaveBeenCalledWith(message);
    // The widget rendered it before the host saw it.
    expect(
      createdElements.some(
        (el) =>
          el.textContent === "hi" ||
          el.children.some((c) => c.textContent === "hi"),
      ),
    ).toBe(true);
  });

  it("onStatus gets each status line change", async () => {
    const onStatus = vi.fn();
    await connect({ onStatus });
    expect(onStatus).toHaveBeenCalledWith({
      text: "Connecting…",
      loading: true,
      error: false,
    });
    expect(onStatus).toHaveBeenLastCalledWith({
      text: "Connected",
      loading: false,
      error: false,
    });
  });

  it("a throwing host hook is logged and does not break the widget", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const boom = () => {
      throw new Error("boom");
    };
    const { opts } = await connect({
      onSession: boom,
      onSessionEnd: boom,
      onStatus: boom,
      onControlMessage: boom,
      onAgentAudioTrack: boom,
    });
    opts.onControlMessage!({ type: "chat_reply", text: "still drawn" });
    opts.onAgentAudioTrack!({});
    expect(warn).toHaveBeenCalled();
    expect(
      createdElements.some(
        (el) =>
          el.textContent === "still drawn" ||
          el.children.some((c) => c.textContent === "still drawn"),
      ),
    ).toBe(true);
    findButtonByText(mount, "Disconnect")!.click();
    warn.mockRestore();
  });

  it("audio.deviceId, audio.silent and runtime reach connectBrowserSession", async () => {
    const runtime = { WebSocket: class {}, RTCPeerConnection: class {} };
    const { opts } = await connect({
      audio: { deviceId: "mic-7", silent: true },
      runtime,
    });
    expect(opts.audioInputDeviceId).toBe("mic-7");
    expect(opts.silentMic).toBe(true);
    expect(opts.runtime).toBe(runtime);
  });

  it("without audio options connectBrowserSession gets no device and no silent flag", async () => {
    const { opts } = await connect();
    expect(opts.audioInputDeviceId).toBeUndefined();
    expect(opts.silentMic).toBeUndefined();
    expect(opts.runtime).toBeUndefined();
  });

  it("a recoverable session error does not end the session for the host", async () => {
    const onSession = vi.fn();
    const onSessionEnd = vi.fn();
    const { opts } = await connect({ onSession, onSessionEnd });
    onSession.mockClear();
    opts.onSessionError!({
      type: "session_error",
      code: "RUNNER_INTERNAL",
      message: "x",
      session_id: "s",
      recoverable: true,
    });
    expect(onSessionEnd).not.toHaveBeenCalled();
    expect(onSession).not.toHaveBeenCalled();
    findButtonByText(mount, "Disconnect")!.click();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledWith({ reason: "closed" });
  });

  it("destroy while connectBrowserSession is pending disconnects the session and hands it out nowhere", async () => {
    const onSession = vi.fn();
    const onSessionEnd = vi.fn();
    const onStatus = vi.fn();
    let release!: (value: unknown) => void;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const disconnect = vi.fn();
    const waitForConnected = vi.fn(async () => undefined);
    connectBrowserSession.mockReturnValueOnce(held);
    const widget = createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mode: BrowserSessionModeType.Chat,
      mount: mount as unknown as HTMLElement,
      onSession,
      onSessionEnd,
      onStatus,
    });
    findButtonByText(mount, "Connect")!.click();
    await vi.waitFor(() => expect(connectBrowserSession).toHaveBeenCalled());
    widget.destroy();
    onSession.mockClear();
    onSessionEnd.mockClear();
    onStatus.mockClear();
    release({
      mode: BrowserSessionModeType.Chat,
      disconnect,
      waitForConnected,
      getConnectionStatus: () => ({}),
      getAudioInputState: () => "live" as const,
      sendChat: vi.fn(),
    });
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(waitForConnected).not.toHaveBeenCalled();
    expect(onSession).not.toHaveBeenCalled();
    expect(onSessionEnd).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  const pendingConnect = () => {
    let release!: (value: unknown) => void;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const disconnect = vi.fn();
    const session = {
      mode: BrowserSessionModeType.Chat,
      disconnect,
      waitForConnected: vi.fn(async () => undefined),
      getConnectionStatus: () => ({}),
      getAudioInputState: () => "live" as const,
      sendChat: vi.fn(),
    };
    connectBrowserSession.mockReturnValueOnce(held);
    return { release: () => release(session), disconnect, session };
  };

  it("Connect while connecting cancels the pending start: one start, the late session is disconnected and never handed out", async () => {
    const onSession = vi.fn();
    const onSessionEnd = vi.fn();
    const { release, disconnect } = pendingConnect();
    createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mode: BrowserSessionModeType.Chat,
      mount: mount as unknown as HTMLElement,
      onSession,
      onSessionEnd,
    });
    findButtonByText(mount, "Connect")!.click();
    await vi.waitFor(() => expect(connectBrowserSession).toHaveBeenCalled());
    expect(findButtonByText(mount, "Connect")).toBeUndefined();
    const cancel = findButtonByText(mount, "Cancel")!;
    cancel.click();
    cancel.click();
    expect(disconnect).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(findButtonByText(mount, "Connect")).toBeDefined(),
    );
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(connectBrowserSession).toHaveBeenCalledTimes(1);
    expect(onSession).not.toHaveBeenCalled();
    expect(onSessionEnd).not.toHaveBeenCalled();
  });

  it("after a cancelled start has settled, Connect starts a new session normally", async () => {
    const onSession = vi.fn();
    const { release, disconnect } = pendingConnect();
    createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mode: BrowserSessionModeType.Chat,
      mount: mount as unknown as HTMLElement,
      onSession,
    });
    findButtonByText(mount, "Connect")!.click();
    await vi.waitFor(() => expect(connectBrowserSession).toHaveBeenCalled());
    findButtonByText(mount, "Cancel")!.click();
    release();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(findButtonByText(mount, "Connect")).toBeDefined(),
    );
    findButtonByText(mount, "Connect")!.click();
    await vi.waitFor(() =>
      expect(connectBrowserSession).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(onSession).toHaveBeenCalledTimes(1));
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(findButtonByText(mount, "Disconnect")).toBeDefined();
  });

  const statusText = () => {
    const statusLine = createdElements.find((el) =>
      el.classList.contains(WIDGET_CSS_CLASSES.status),
    )!;
    return statusLine.children[1]!.textContent;
  };

  const widgetFor = (extra: Record<string, unknown>) =>
    createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mode: BrowserSessionModeType.Chat,
      mount: mount as unknown as HTMLElement,
      ...extra,
    });

  it("Cancel while the built-in startSession is pending aborts its signal and never connects", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const onSessionEnd = vi.fn();
      startSession.mockImplementationOnce(
        (opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      );
      widgetFor({ onSessionEnd });
      findButtonByText(mount, "Connect")!.click();
      await vi.waitFor(() => expect(startSession).toHaveBeenCalled());
      findButtonByText(mount, "Cancel")!.click();
      await vi.waitFor(() =>
        expect(findButtonByText(mount, "Connect")).toBeDefined(),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        (startSession.mock.calls[0]![0] as { signal: AbortSignal }).signal
          .aborted,
      ).toBe(true);
      expect(connectBrowserSession).not.toHaveBeenCalled();
      expect(statusText()).toBe("Disconnected");
      expect(onSessionEnd).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("Cancel while a startSession provider is pending aborts the provider signal", async () => {
    const onSession = vi.fn();
    const onSessionEnd = vi.fn();
    let providerSignal!: AbortSignal;
    let resolveProvider!: (value: unknown) => void;
    const provider = vi.fn((signal: AbortSignal) => {
      providerSignal = signal;
      return new Promise((resolve) => {
        resolveProvider = resolve;
      });
    });
    widgetFor({
      clientKey: undefined,
      startSession: provider,
      onSession,
      onSessionEnd,
    });
    findButtonByText(mount, "Connect")!.click();
    await vi.waitFor(() => expect(provider).toHaveBeenCalled());
    findButtonByText(mount, "Cancel")!.click();
    expect(providerSignal.aborted).toBe(true);
    resolveProvider({
      ok: true,
      credentials: {
        session_id: "s",
        mode: "chat",
        room_id: "r",
        join_token: "j",
        signaling_url: "ws://127.0.0.1:8080/ws",
        ice_servers: [],
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    await vi.waitFor(() =>
      expect(findButtonByText(mount, "Connect")).toBeDefined(),
    );
    expect(connectBrowserSession).not.toHaveBeenCalled();
    expect(onSession).not.toHaveBeenCalled();
    expect(onSessionEnd).not.toHaveBeenCalled();
  });

  it("Cancel while waitForConnected is pending ends the session once and never hands it out", async () => {
    const onSession = vi.fn();
    const onSessionEnd = vi.fn();
    let resolveConnected!: () => void;
    const disconnect = vi.fn();
    const session = {
      mode: BrowserSessionModeType.Chat,
      disconnect,
      waitForConnected: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveConnected = resolve;
          }),
      ),
      getConnectionStatus: () => ({}),
      getAudioInputState: () => "live" as const,
      sendChat: vi.fn(),
    };
    connectBrowserSession.mockResolvedValueOnce(session);
    widgetFor({ onSession, onSessionEnd });
    findButtonByText(mount, "Connect")!.click();
    await vi.waitFor(() => expect(session.waitForConnected).toHaveBeenCalled());
    findButtonByText(mount, "Cancel")!.click();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledWith({ reason: "closed" });
    onSession.mockClear();
    resolveConnected();
    await vi.waitFor(() =>
      expect(findButtonByText(mount, "Connect")).toBeDefined(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSession).not.toHaveBeenCalledWith(session);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe("Disconnected");
  });

  it("Cancel while waitForConnected is pending, then it rejects: one disconnect, Disconnected, one onSessionEnd", async () => {
    const onSession = vi.fn();
    const onSessionEnd = vi.fn();
    let rejectConnected!: (error: Error) => void;
    const disconnect = vi.fn();
    const session = {
      mode: BrowserSessionModeType.Chat,
      disconnect,
      waitForConnected: vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            rejectConnected = reject;
          }),
      ),
      getConnectionStatus: () => ({}),
      getAudioInputState: () => "live" as const,
      sendChat: vi.fn(),
    };
    connectBrowserSession.mockResolvedValueOnce(session);
    widgetFor({ onSession, onSessionEnd });
    findButtonByText(mount, "Connect")!.click();
    await vi.waitFor(() => expect(session.waitForConnected).toHaveBeenCalled());
    findButtonByText(mount, "Cancel")!.click();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledWith({ reason: "closed" });
    rejectConnected(new Error("ice failed"));
    await vi.waitFor(() =>
      expect(findButtonByText(mount, "Connect")).toBeDefined(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledWith({ reason: "closed" });
    expect(statusText()).toBe("Disconnected");
    expect(onSession).not.toHaveBeenCalledWith(session);
  });

  it("onDebugEvent receives every debug event of the widget's console, and a throwing hook breaks nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onDebugEvent = vi.fn(() => {
      throw new Error("host broke");
    });
    const onSession = vi.fn();
    const { opts, session } = await connect({ onDebugEvent, onSession });
    const sink = opts.onDebugEvent as unknown as {
      info: (source: string, name: string, detail?: string) => unknown;
    };
    sink.info("signaling", "join", "room r");
    expect(onDebugEvent).toHaveBeenCalledTimes(1);
    expect(onDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        source: "signaling",
        name: "join",
        detail: "room r",
        ts: expect.any(String),
      }),
    );
    expect(warn).toHaveBeenCalled();
    expect(onSession).toHaveBeenLastCalledWith(session);
    warn.mockRestore();
  });

  it("a failed connect reports the session end once and never hands out the session", async () => {
    const onSession = vi.fn();
    const onSessionEnd = vi.fn();
    const failure = new Error("timeout");
    connectBrowserSession.mockResolvedValueOnce({
      mode: BrowserSessionModeType.Chat,
      disconnect: vi.fn(),
      waitForConnected: vi.fn(async () => {
        throw failure;
      }),
      getConnectionStatus: () => ({}),
      getAudioInputState: () => "live" as const,
      sendChat: vi.fn(),
    });
    createVoiceThereWidget({
      projectId: "p",
      apiBase: "https://api.example.com",
      clientKey: "key",
      mode: BrowserSessionModeType.Chat,
      mount: mount as unknown as HTMLElement,
      onSession,
      onSessionEnd,
    });
    findButtonByText(mount, "Connect")!.click();
    await vi.waitFor(() => expect(onSessionEnd).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledWith({
      reason: "error",
      error: failure,
    });
    expect(onSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ waitForConnected: expect.anything() }),
    );
    expect(findButtonByText(mount, "Connect")).toBeDefined();
  });

  describe("Mute button", () => {
    const voiceSession = (calls: string[] = []) => ({
      mode: BrowserSessionModeType.Voice,
      disconnect: vi.fn(),
      waitForConnected: vi.fn(async () => undefined),
      getConnectionStatus: () => ({}),
      getAudioInputState: () => "live" as const,
      setMicMuted: vi.fn((muted: boolean) => {
        calls.push(`mute:${muted}`);
      }),
      isMicMuted: () => false,
      unlockAudioPlayback: vi.fn(async () => true),
      getAudioPlaybackState: () => "idle" as const,
      sendChat: vi.fn(),
    });

    const widgetIn = (
      mode: BrowserSessionModeType,
      extra: Record<string, unknown> = {},
    ) =>
      createVoiceThereWidget({
        projectId: "p",
        apiBase: "https://api.example.com",
        clientKey: "key",
        mode,
        mount: mount as unknown as HTMLElement,
        ...extra,
      });

    const muteEl = () =>
      createdElements.find((el) =>
        el.classList.contains(WIDGET_CSS_CLASSES.mute),
      )!;

    it("toggles the session mic and its label", async () => {
      const session = voiceSession();
      connectBrowserSession.mockResolvedValueOnce(session);
      widgetIn(BrowserSessionModeType.Voice);
      findButtonByText(mount, "Connect")!.click();
      await vi.waitFor(() =>
        expect(findButtonByText(mount, "Disconnect")).toBeDefined(),
      );
      session.setMicMuted.mockClear();
      findButtonByText(mount, "Mute")!.click();
      expect(session.setMicMuted).toHaveBeenLastCalledWith(true);
      expect(muteEl().textContent).toBe("Unmute");
      expect(muteEl().getAttribute("aria-pressed")).toBe("true");
      findButtonByText(mount, "Unmute")!.click();
      expect(session.setMicMuted).toHaveBeenLastCalledWith(false);
      expect(muteEl().textContent).toBe("Mute");
      expect(muteEl().getAttribute("aria-pressed")).toBe("false");
    });

    it("Mute before Connect applies to the new session before it is handed out", async () => {
      const calls: string[] = [];
      const session = voiceSession(calls);
      connectBrowserSession.mockResolvedValueOnce(session);
      const onSession = vi.fn(() => {
        calls.push("onSession");
      });
      widgetIn(BrowserSessionModeType.Voice, { onSession });
      findButtonByText(mount, "Mute")!.click();
      findButtonByText(mount, "Connect")!.click();
      await vi.waitFor(() => expect(onSession).toHaveBeenCalled());
      expect(calls.indexOf("mute:true")).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf("mute:true")).toBeLessThan(
        calls.indexOf("onSession"),
      );
    });

    it("the mute choice holds for the next session", async () => {
      const first = voiceSession();
      const second = voiceSession();
      connectBrowserSession
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      widgetIn(BrowserSessionModeType.Voice);
      findButtonByText(mount, "Connect")!.click();
      await vi.waitFor(() =>
        expect(findButtonByText(mount, "Disconnect")).toBeDefined(),
      );
      findButtonByText(mount, "Mute")!.click();
      findButtonByText(mount, "Disconnect")!.click();
      findButtonByText(mount, "Connect")!.click();
      await vi.waitFor(() =>
        expect(findButtonByText(mount, "Disconnect")).toBeDefined(),
      );
      expect(second.setMicMuted).toHaveBeenCalledWith(true);
    });

    it("typing works while muted", async () => {
      const session = voiceSession();
      connectBrowserSession.mockResolvedValueOnce(session);
      widgetIn(BrowserSessionModeType.Voice);
      findButtonByText(mount, "Connect")!.click();
      await vi.waitFor(() =>
        expect(findButtonByText(mount, "Disconnect")).toBeDefined(),
      );
      findButtonByText(mount, "Mute")!.click();
      const input = createdElements.find((el) => el.tagName === "INPUT") as
        (MockElement & { value?: string }) | undefined;
      input!.value = "hello";
      input!.onkeydown?.({ key: "Enter" });
      expect(session.sendChat).toHaveBeenCalledWith("hello");
    });

    it("is hidden in chat mode and with audio.silent", () => {
      widgetIn(BrowserSessionModeType.Chat);
      expect(muteEl().style.display).toBe("none");
      createdElements.length = 0;
      widgetIn(BrowserSessionModeType.Voice, { audio: { silent: true } });
      expect(muteEl().style.display).toBe("none");
      createdElements.length = 0;
      widgetIn(BrowserSessionModeType.Voice);
      expect(muteEl().style.display).toBe("");
    });
  });
});
