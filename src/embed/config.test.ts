import { describe, expect, it } from "vitest";
import {
  WidgetConfigError,
  parseVoiceThereWidgetConfigJson,
  parseVoiceThereWidgetConfigV1,
} from "./config.js";

const VALID_CONFIG = {
  v: 1,
  publicId: "w_abc123",
  projectId: "11111111-1111-4111-8111-111111111111",
  apiBase: "https://sessions.voicethere.dev/v1",
  revision: 3,
  preset: "pill-dark",
  theme: { primary: "#06b6d4", background: "#0b1220", text: "#e2e8f0" },
  launcherLabel: "Chat",
  greeting: "Hi — how can we help?",
  position: "bottom-right",
  mode: "chat",
} as const;

describe("parseVoiceThereWidgetConfigV1", () => {
  it("accepts a valid v1 config", () => {
    expect(parseVoiceThereWidgetConfigV1({ ...VALID_CONFIG })).toEqual({
      ...VALID_CONFIG,
    });
  });

  it("accepts short hex colors", () => {
    expect(
      parseVoiceThereWidgetConfigV1({
        v: 1,
        theme: { primary: "#abc" },
      }).theme,
    ).toEqual({ primary: "#abc" });
  });

  it("accepts extended position, offsets, fonts, chat theme, and customCss", () => {
    expect(
      parseVoiceThereWidgetConfigV1({
        v: 1,
        position: "top-left",
        positionOffset: { top: "8px", left: "1rem" },
        customCss: ".vt-widget { opacity: 1; }",
        theme: {
          fontFamily: "Inter, sans-serif",
          fontSize: "15px",
          chat: {
            incoming: {
              fontFamily: "Georgia, serif",
              fontSize: "14px",
              color: "#ffffff",
              bubble: "#334155",
            },
            outgoing: { bubble: "#0891b2", color: "#f8fafc" },
            panelWidth: "360px",
            panelHeight: "480px",
            panelRadius: "16px",
            headerBackground: "#0f172a",
            inputBackground: "#1e293b",
            inputColor: "#e2e8f0",
          },
        },
      }),
    ).toMatchObject({
      position: "top-left",
      positionOffset: { top: "8px", left: "1rem" },
      customCss: ".vt-widget { opacity: 1; }",
      theme: {
        fontFamily: "Inter, sans-serif",
        fontSize: "15px",
        chat: {
          incoming: { fontFamily: "Georgia, serif", fontSize: "14px" },
        },
      },
    });
  });

  it("accepts streamSpokenText boolean", () => {
    expect(
      parseVoiceThereWidgetConfigV1({
        v: 1,
        streamSpokenText: true,
      }).streamSpokenText,
    ).toBe(true);
    expect(() =>
      parseVoiceThereWidgetConfigV1({
        v: 1,
        streamSpokenText: "yes",
      }),
    ).toThrow(WidgetConfigError);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseVoiceThereWidgetConfigJson("{")).toThrow(
      WidgetConfigError,
    );
    expect(() => parseVoiceThereWidgetConfigJson("not json")).toThrow(
      /invalid/i,
    );
  });

  it("rejects wrong version", () => {
    expect(() =>
      parseVoiceThereWidgetConfigV1({ v: 2, preset: "pill-dark" }),
    ).toThrow(/v must be 1/);
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parseVoiceThereWidgetConfigV1({ v: 1, extra: true })).toThrow(
      /Unknown config key/,
    );
  });

  it("rejects secret-like keys", () => {
    expect(() =>
      parseVoiceThereWidgetConfigV1({ v: 1, clientKey: "secret" }),
    ).toThrow(/Forbidden config key.*clientKey/i);
    expect(() =>
      parseVoiceThereWidgetConfigV1({ v: 1, authorization: "Bearer x" }),
    ).toThrow(/authorization/i);
    expect(() =>
      parseVoiceThereWidgetConfigV1({ v: 1, token: "opaque" }),
    ).toThrow(/token/i);
  });

  it("rejects invalid preset and colors", () => {
    expect(() =>
      parseVoiceThereWidgetConfigV1({ v: 1, preset: "neon-glow" }),
    ).toThrow(/preset must be one of/);
    expect(() =>
      parseVoiceThereWidgetConfigV1({
        v: 1,
        theme: { primary: "red" },
      }),
    ).toThrow(/hex color/i);
  });

  it("rejects </style in customCss and unsafe fontFamily", () => {
    expect(() =>
      parseVoiceThereWidgetConfigV1({
        v: 1,
        customCss: "x </style> y",
      }),
    ).toThrow(/customCss must not contain <\/style/i);
    expect(() =>
      parseVoiceThereWidgetConfigV1({
        v: 1,
        theme: { fontFamily: "<script>" },
      }),
    ).toThrow(/must not contain < or >/);
  });

  it("rejects invalid CSS lengths", () => {
    expect(() =>
      parseVoiceThereWidgetConfigV1({
        v: 1,
        theme: { fontSize: "12pt" },
      }),
    ).toThrow(/CSS length/i);
    expect(() =>
      parseVoiceThereWidgetConfigV1({
        v: 1,
        positionOffset: { top: "not-a-length" },
      }),
    ).toThrow(/positionOffset.top/);
  });

  it("rejects invalid position and mode", () => {
    expect(() =>
      parseVoiceThereWidgetConfigV1({ v: 1, position: "middle" }),
    ).toThrow(/position must be one of/);
    expect(() =>
      parseVoiceThereWidgetConfigV1({ v: 1, mode: "video" }),
    ).toThrow(/mode must be/);
  });
});
