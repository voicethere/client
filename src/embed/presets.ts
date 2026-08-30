import type { VoiceThereWidgetTheme, WidgetPresetId } from "./config.js";

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
  defaultTheme: Required<VoiceThereWidgetTheme>;
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

export type ResolvedWidgetTheme = Required<VoiceThereWidgetTheme>;

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

  panel.style.borderRadius = preset.panelBorderRadius;
  panel.style.padding = preset.panelPadding;
  panel.style.width = preset.panelWidth;
  panel.style.height = preset.panelHeight;
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

export function applyWidgetPosition(
  root: HTMLElement,
  position: "bottom-right" | "bottom-left",
  presetId: WidgetPresetId,
): void {
  root.style.bottom = "16px";
  root.dataset.voicetherePosition = position;

  if (presetId === "minimal-bar") {
    root.style.left = "0";
    root.style.right = "0";
    root.style.bottom = "0";
    return;
  }

  if (position === "bottom-left") {
    root.style.left = "16px";
    root.style.right = "";
  } else {
    root.style.right = "16px";
    root.style.left = "";
  }
}
