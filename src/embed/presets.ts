import type {
  VoiceThereWidgetTheme,
  WidgetPosition,
  WidgetPositionOffset,
  WidgetPresetId,
} from "./config.js";

export type WidgetPresetLayout = {
  launcherBorderRadius: string;
  launcherPadding: string;
  launcherMinWidth: string;
  launcherMinHeight: string;
  panelBorderRadius: string;
  panelPadding: string;
  panelWidth: string;
  panelHeight: string;
  panelBorder: string;
  panelBoxShadow: string;
  defaultTheme: Required<
    Pick<VoiceThereWidgetTheme, "primary" | "background" | "text">
  >;
  /** Distinct marker for tests — preset-specific layout token. */
  layoutToken: string;
};

const PRESETS: Record<WidgetPresetId, WidgetPresetLayout> = {
  "pill-dark": {
    launcherBorderRadius: "999px",
    launcherPadding: "12px 16px",
    launcherMinWidth: "",
    launcherMinHeight: "",
    panelBorderRadius: "12px",
    panelPadding: "12px",
    panelWidth: "320px",
    panelHeight: "420px",
    panelBorder: "1px solid rgba(255,255,255,0.1)",
    panelBoxShadow: "0 8px 30px rgba(0,0,0,0.35)",
    defaultTheme: {
      primary: "#06b6d4",
      background: "#0b1220",
      text: "#e2e8f0",
    },
    layoutToken: "pill-dark",
  },
  "pill-light": {
    launcherBorderRadius: "999px",
    launcherPadding: "12px 16px",
    launcherMinWidth: "",
    launcherMinHeight: "",
    panelBorderRadius: "12px",
    panelPadding: "12px",
    panelWidth: "320px",
    panelHeight: "420px",
    panelBorder: "1px solid rgba(15,23,42,0.12)",
    panelBoxShadow: "0 8px 24px rgba(15,23,42,0.12)",
    defaultTheme: {
      primary: "#0891b2",
      background: "#f8fafc",
      text: "#0f172a",
    },
    layoutToken: "pill-light",
  },
  "rounded-card": {
    launcherBorderRadius: "20px",
    launcherPadding: "14px 20px",
    launcherMinWidth: "",
    launcherMinHeight: "",
    panelBorderRadius: "20px",
    panelPadding: "16px",
    panelWidth: "340px",
    panelHeight: "440px",
    panelBorder: "1px solid rgba(255,255,255,0.12)",
    panelBoxShadow: "0 12px 40px rgba(0,0,0,0.4)",
    defaultTheme: {
      primary: "#06b6d4",
      background: "#0b1220",
      text: "#e2e8f0",
    },
    layoutToken: "rounded-card",
  },
  "minimal-bar": {
    launcherBorderRadius: "8px",
    launcherPadding: "10px 14px",
    launcherMinWidth: "100%",
    launcherMinHeight: "",
    panelBorderRadius: "0",
    panelPadding: "12px 16px",
    panelWidth: "100%",
    panelHeight: "360px",
    panelBorder: "1px solid rgba(255,255,255,0.08)",
    panelBoxShadow: "0 -4px 24px rgba(0,0,0,0.25)",
    defaultTheme: {
      primary: "#06b6d4",
      background: "#0b1220",
      text: "#e2e8f0",
    },
    layoutToken: "minimal-bar",
  },
  "voice-orb": {
    launcherBorderRadius: "50%",
    launcherPadding: "0",
    launcherMinWidth: "56px",
    launcherMinHeight: "56px",
    panelBorderRadius: "16px",
    panelPadding: "12px",
    panelWidth: "320px",
    panelHeight: "420px",
    panelBorder: "1px solid rgba(255,255,255,0.1)",
    panelBoxShadow: "0 8px 30px rgba(0,0,0,0.35)",
    defaultTheme: {
      primary: "#06b6d4",
      background: "#0b1220",
      text: "#e2e8f0",
    },
    layoutToken: "voice-orb",
  },
};

export function getWidgetPreset(id: WidgetPresetId): WidgetPresetLayout {
  return PRESETS[id];
}

export type ApplyPresetTarget = {
  root: HTMLElement;
  launcher: HTMLButtonElement;
  panel: HTMLDivElement;
};

export type ResolvedWidgetTheme = Required<
  Pick<VoiceThereWidgetTheme, "primary" | "background" | "text">
>;

export function resolveWidgetTheme(
  presetId: WidgetPresetId,
  themeOverride?: VoiceThereWidgetTheme,
): ResolvedWidgetTheme {
  const preset = getWidgetPreset(presetId);
  return {
    primary: themeOverride?.primary ?? preset.defaultTheme.primary,
    background: themeOverride?.background ?? preset.defaultTheme.background,
    text: themeOverride?.text ?? preset.defaultTheme.text,
  };
}

export function applyPreset(
  target: ApplyPresetTarget,
  presetId: WidgetPresetId,
  themeOverride?: VoiceThereWidgetTheme,
): ResolvedWidgetTheme {
  const preset = getWidgetPreset(presetId);
  const theme = resolveWidgetTheme(presetId, themeOverride);
  const { root, launcher, panel } = target;

  root.dataset.voicetherePreset = preset.layoutToken;

  launcher.style.borderRadius = preset.launcherBorderRadius;
  launcher.style.padding = preset.launcherPadding;
  launcher.style.minWidth = preset.launcherMinWidth;
  launcher.style.minHeight = preset.launcherMinHeight;
  launcher.style.background = theme.primary;
  launcher.style.color = theme.text;

  const chat = themeOverride?.chat;
  panel.style.borderRadius = chat?.panelRadius ?? preset.panelBorderRadius;
  panel.style.padding = preset.panelPadding;
  panel.style.width = chat?.panelWidth ?? preset.panelWidth;
  panel.style.height = chat?.panelHeight ?? preset.panelHeight;
  panel.style.border = preset.panelBorder;
  panel.style.boxShadow = preset.panelBoxShadow;
  panel.style.background = theme.background;
  panel.style.color = theme.text;

  if (presetId === "minimal-bar") {
    root.style.left = "0";
    root.style.right = "0";
    root.style.width = "100%";
  } else {
    root.style.width = "";
  }

  return theme;
}

const INSET = "16px";

function clearPositionInsets(root: HTMLElement): void {
  root.style.top = "";
  root.style.right = "";
  root.style.bottom = "";
  root.style.left = "";
  root.style.transform = "";
}

/**
 * Named corners/edges use a 16px inset. Center-aligned positions use 50% + translate
 * so the widget stays anchored on the chosen axis when the panel opens.
 */
export function applyWidgetPosition(
  root: HTMLElement,
  position: WidgetPosition,
  presetId: WidgetPresetId,
  positionOffset?: WidgetPositionOffset,
): void {
  clearPositionInsets(root);
  root.dataset.voicetherePosition = position;

  if (position === "custom") {
    if (positionOffset?.top !== undefined) root.style.top = positionOffset.top;
    if (positionOffset?.right !== undefined) {
      root.style.right = positionOffset.right;
    }
    if (positionOffset?.bottom !== undefined) {
      root.style.bottom = positionOffset.bottom;
    }
    if (positionOffset?.left !== undefined)
      root.style.left = positionOffset.left;
    if (presetId === "minimal-bar") {
      root.style.width = positionOffset ? "" : "100%";
    }
    return;
  }

  if (presetId === "minimal-bar") {
    root.style.left = "0";
    root.style.right = "0";
    root.style.bottom = "0";
    root.style.width = "100%";
    return;
  }

  switch (position) {
    case "bottom-right":
      root.style.bottom = INSET;
      root.style.right = INSET;
      break;
    case "bottom-left":
      root.style.bottom = INSET;
      root.style.left = INSET;
      break;
    case "top-right":
      root.style.top = INSET;
      root.style.right = INSET;
      break;
    case "top-left":
      root.style.top = INSET;
      root.style.left = INSET;
      break;
    case "bottom-center":
      root.style.bottom = INSET;
      root.style.left = "50%";
      root.style.transform = "translateX(-50%)";
      break;
    case "top-center":
      root.style.top = INSET;
      root.style.left = "50%";
      root.style.transform = "translateX(-50%)";
      break;
    case "center-right":
      root.style.right = INSET;
      root.style.top = "50%";
      root.style.transform = "translateY(-50%)";
      break;
    case "center-left":
      root.style.left = INSET;
      root.style.top = "50%";
      root.style.transform = "translateY(-50%)";
      break;
    default:
      root.style.bottom = INSET;
      root.style.right = INSET;
      break;
  }
}
