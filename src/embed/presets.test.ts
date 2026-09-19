import { describe, expect, it } from "vitest";
import { WIDGET_PRESET_IDS } from "./config.js";
import {
  applyPreset,
  applyWidgetPosition,
  getWidgetPreset,
  resolveWidgetTheme,
} from "./presets.js";

function createTarget() {
  return {
    root: { style: {}, dataset: {} } as unknown as HTMLDivElement,
    launcher: { style: {} } as unknown as HTMLButtonElement,
    panel: { style: {} } as unknown as HTMLDivElement,
  };
}

describe("widget presets", () => {
  it("each preset applies a distinct layout token", () => {
    const tokens = new Set<string>();
    for (const id of WIDGET_PRESET_IDS) {
      const target = createTarget();
      applyPreset(target, id);
      const token = getWidgetPreset(id).layoutToken;
      tokens.add(token);
      expect(
        (target.root as { dataset: Record<string, string> }).dataset
          .voicetherePreset,
      ).toBe(token);
    }
    expect(tokens.size).toBe(WIDGET_PRESET_IDS.length);
  });

  it("brand primary color overrides preset default on launcher", () => {
    const target = createTarget();
    const theme = applyPreset(target, "pill-light", { primary: "#ff00aa" });
    expect(theme.primary).toBe("#ff00aa");
    expect(target.launcher.style.background).toBe("#ff00aa");
    expect(target.panel.style.background).toBe("#f8fafc");
  });

  it("resolveWidgetTheme keeps preset defaults without override", () => {
    expect(resolveWidgetTheme("voice-orb").primary).toBe("#06b6d4");
  });

  it("applyWidgetPosition supports top-left and custom offsets", () => {
    const root = { style: {}, dataset: {} } as unknown as HTMLDivElement;
    applyWidgetPosition(root, "top-left", "pill-dark");
    expect(root.style.top).toBe("16px");
    expect(root.style.left).toBe("16px");
    expect(root.style.bottom).toBe("");

    applyWidgetPosition(root, "custom", "pill-dark", {
      top: "24px",
      right: "12px",
    });
    expect(root.style.top).toBe("24px");
    expect(root.style.right).toBe("12px");
    expect(root.style.transform).toBe("");
  });
});
