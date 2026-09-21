import type { BrowserSessionMode } from "../browser/browser-session.js";
import { BrowserSessionModeType } from "../browser/browser-session.js";

export type WidgetMessageRoleTheme = {
  fontFamily?: string;
  fontSize?: string;
  color?: string;
  bubble?: string;
};

export type VoiceThereWidgetChatTheme = {
  incoming?: WidgetMessageRoleTheme;
  outgoing?: WidgetMessageRoleTheme;
  headerBackground?: string;
  inputBackground?: string;
  inputColor?: string;
  panelWidth?: string;
  panelHeight?: string;
  panelRadius?: string;
};

export type VoiceThereWidgetTheme = {
  primary?: string;
  background?: string;
  text?: string;
  fontFamily?: string;
  fontSize?: string;
  chat?: VoiceThereWidgetChatTheme;
};

export const WIDGET_PRESET_IDS = [
  "pill-dark",
  "pill-light",
  "rounded-card",
  "minimal-bar",
  "voice-orb",
] as const;

export type WidgetPresetId = (typeof WIDGET_PRESET_IDS)[number];

export function isWidgetPresetId(value: string): value is WidgetPresetId {
  return (WIDGET_PRESET_IDS as readonly string[]).includes(value);
}

export const WIDGET_CONFIG_VERSION = 1 as const;

export const WIDGET_POSITIONS = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
  "bottom-center",
  "top-center",
  "center-right",
  "center-left",
  "custom",
] as const;

export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];

export type WidgetPositionOffset = {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
};

export type WidgetConfigMode = "chat" | "voice";

export type VoiceThereWidgetConfigV1 = {
  v: typeof WIDGET_CONFIG_VERSION;
  publicId?: string;
  projectId?: string;
  apiBase?: string;
  revision?: number;
  preset?: WidgetPresetId;
  theme?: VoiceThereWidgetTheme;
  launcherLabel?: string;
  greeting?: string;
  position?: WidgetPosition;
  positionOffset?: WidgetPositionOffset;
  customCss?: string;
  mode?: WidgetConfigMode;
  streamSpokenText?: boolean;
};

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "v",
  "publicId",
  "projectId",
  "apiBase",
  "revision",
  "preset",
  "theme",
  "launcherLabel",
  "greeting",
  "position",
  "positionOffset",
  "customCss",
  "mode",
  "streamSpokenText",
]);

const ALLOWED_THEME_KEYS = new Set([
  "primary",
  "background",
  "text",
  "fontFamily",
  "fontSize",
  "chat",
]);

const ALLOWED_CHAT_KEYS = new Set([
  "incoming",
  "outgoing",
  "headerBackground",
  "inputBackground",
  "inputColor",
  "panelWidth",
  "panelHeight",
  "panelRadius",
]);

const ALLOWED_MESSAGE_ROLE_KEYS = new Set([
  "fontFamily",
  "fontSize",
  "color",
  "bubble",
]);

const ALLOWED_OFFSET_KEYS = new Set(["top", "right", "bottom", "left"]);

const SECRET_LIKE_KEYS = new Set([
  "clientkey",
  "authorization",
  "token",
  "apikey",
  "secret",
  "bearertoken",
  "accesstoken",
  "refreshtoken",
]);

const MAX_PROJECT_ID_LEN = 128;
const MAX_API_BASE_LEN = 512;
const MAX_PUBLIC_ID_LEN = 64;
const MAX_LAUNCHER_LABEL_LEN = 64;
const MAX_GREETING_LEN = 500;
const MAX_FONT_FAMILY_LEN = 128;
const MAX_CUSTOM_CSS_LEN = 16384;
const MAX_CSS_LENGTH_LEN = 24;

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const CSS_LENGTH_RE = /^(?:0|auto|[-+]?\d+(?:\.\d+)?(?:px|%|rem|em|vh|vw))$/;

export class WidgetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WidgetConfigError";
  }
}

export function isValidCssLength(value: string): boolean {
  return value.length <= MAX_CSS_LENGTH_LEN && CSS_LENGTH_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoSecretLikeKeys(obj: Record<string, unknown>, path = ""): void {
  for (const key of Object.keys(obj)) {
    const normalized = key.toLowerCase();
    if (SECRET_LIKE_KEYS.has(normalized)) {
      throw new WidgetConfigError(
        `Forbidden config key${path}: ${key} (secrets must not appear in CDN config)`,
      );
    }
  }
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new WidgetConfigError(`Unknown config key${path}: ${key}`);
    }
  }
}

function parseString(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== "string") {
    throw new WidgetConfigError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new WidgetConfigError(`${field} must not be empty`);
  }
  if (trimmed.length > maxLen) {
    throw new WidgetConfigError(`${field} exceeds max length ${maxLen}`);
  }
  return trimmed;
}

function parseOptionalString(
  value: unknown,
  field: string,
  maxLen: number,
): string | undefined {
  if (value === undefined) return undefined;
  return parseString(value, field, maxLen);
}

function parseHexColor(value: unknown, field: string): string {
  const color = parseString(value, field, 7);
  if (!HEX_COLOR_RE.test(color)) {
    throw new WidgetConfigError(
      `${field} must be a hex color (#RGB or #RRGGBB)`,
    );
  }
  return color;
}

function parseCssLength(value: unknown, field: string): string {
  const len = parseString(value, field, MAX_CSS_LENGTH_LEN);
  if (!isValidCssLength(len)) {
    throw new WidgetConfigError(
      `${field} must be a CSS length (0, auto, or number with px|%|rem|em|vh|vw)`,
    );
  }
  return len;
}

function parseFontFamily(value: unknown, field: string): string {
  const family = parseString(value, field, MAX_FONT_FAMILY_LEN);
  if (family.includes("<") || family.includes(">")) {
    throw new WidgetConfigError(`${field} must not contain < or >`);
  }
  return family;
}

function parseMessageRoleTheme(
  value: unknown,
  path: string,
): WidgetMessageRoleTheme | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new WidgetConfigError(`${path} must be an object`);
  }
  assertNoSecretLikeKeys(value, path);
  rejectUnknownKeys(value, ALLOWED_MESSAGE_ROLE_KEYS, path);

  const role: WidgetMessageRoleTheme = {};
  if (value.fontFamily !== undefined) {
    role.fontFamily = parseFontFamily(value.fontFamily, `${path}.fontFamily`);
  }
  if (value.fontSize !== undefined) {
    role.fontSize = parseCssLength(value.fontSize, `${path}.fontSize`);
  }
  if (value.color !== undefined) {
    role.color = parseHexColor(value.color, `${path}.color`);
  }
  if (value.bubble !== undefined) {
    role.bubble = parseHexColor(value.bubble, `${path}.bubble`);
  }
  return role;
}

function parseChatTheme(value: unknown): VoiceThereWidgetChatTheme | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new WidgetConfigError("theme.chat must be an object");
  }
  assertNoSecretLikeKeys(value, ".theme.chat");
  rejectUnknownKeys(value, ALLOWED_CHAT_KEYS, ".theme.chat");

  const chat: VoiceThereWidgetChatTheme = {};
  if (value.incoming !== undefined) {
    chat.incoming = parseMessageRoleTheme(
      value.incoming,
      ".theme.chat.incoming",
    );
  }
  if (value.outgoing !== undefined) {
    chat.outgoing = parseMessageRoleTheme(
      value.outgoing,
      ".theme.chat.outgoing",
    );
  }
  if (value.headerBackground !== undefined) {
    chat.headerBackground = parseHexColor(
      value.headerBackground,
      "theme.chat.headerBackground",
    );
  }
  if (value.inputBackground !== undefined) {
    chat.inputBackground = parseHexColor(
      value.inputBackground,
      "theme.chat.inputBackground",
    );
  }
  if (value.inputColor !== undefined) {
    chat.inputColor = parseHexColor(value.inputColor, "theme.chat.inputColor");
  }
  if (value.panelWidth !== undefined) {
    chat.panelWidth = parseCssLength(value.panelWidth, "theme.chat.panelWidth");
  }
  if (value.panelHeight !== undefined) {
    chat.panelHeight = parseCssLength(
      value.panelHeight,
      "theme.chat.panelHeight",
    );
  }
  if (value.panelRadius !== undefined) {
    chat.panelRadius = parseCssLength(
      value.panelRadius,
      "theme.chat.panelRadius",
    );
  }
  return chat;
}

function parseTheme(value: unknown): VoiceThereWidgetTheme | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new WidgetConfigError("theme must be an object");
  }
  assertNoSecretLikeKeys(value, ".theme");
  rejectUnknownKeys(value, ALLOWED_THEME_KEYS, ".theme");

  const theme: VoiceThereWidgetTheme = {};
  if (value.primary !== undefined) {
    theme.primary = parseHexColor(value.primary, "theme.primary");
  }
  if (value.background !== undefined) {
    theme.background = parseHexColor(value.background, "theme.background");
  }
  if (value.text !== undefined) {
    theme.text = parseHexColor(value.text, "theme.text");
  }
  if (value.fontFamily !== undefined) {
    theme.fontFamily = parseFontFamily(value.fontFamily, "theme.fontFamily");
  }
  if (value.fontSize !== undefined) {
    theme.fontSize = parseCssLength(value.fontSize, "theme.fontSize");
  }
  if (value.chat !== undefined) {
    theme.chat = parseChatTheme(value.chat);
  }
  return theme;
}

function parsePosition(value: unknown): WidgetPosition | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WidgetConfigError("position must be a string");
  }
  if (!(WIDGET_POSITIONS as readonly string[]).includes(value)) {
    throw new WidgetConfigError(
      `position must be one of: ${WIDGET_POSITIONS.join(", ")}`,
    );
  }
  return value as WidgetPosition;
}

function parsePositionOffset(value: unknown): WidgetPositionOffset | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new WidgetConfigError("positionOffset must be an object");
  }
  assertNoSecretLikeKeys(value, ".positionOffset");
  rejectUnknownKeys(value, ALLOWED_OFFSET_KEYS, ".positionOffset");

  const offset: WidgetPositionOffset = {};
  if (value.top !== undefined) {
    offset.top = parseCssLength(value.top, "positionOffset.top");
  }
  if (value.right !== undefined) {
    offset.right = parseCssLength(value.right, "positionOffset.right");
  }
  if (value.bottom !== undefined) {
    offset.bottom = parseCssLength(value.bottom, "positionOffset.bottom");
  }
  if (value.left !== undefined) {
    offset.left = parseCssLength(value.left, "positionOffset.left");
  }
  return offset;
}

function parseCustomCss(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const css = parseString(value, "customCss", MAX_CUSTOM_CSS_LEN);
  if (css.toLowerCase().includes("</style")) {
    throw new WidgetConfigError("customCss must not contain </style");
  }
  return css;
}

function parseMode(value: unknown): WidgetConfigMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "chat" && value !== "voice") {
    throw new WidgetConfigError('mode must be "chat" or "voice"');
  }
  return value;
}

function parseStreamSpokenText(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new WidgetConfigError("streamSpokenText must be a boolean");
  }
  return value;
}

function parsePreset(value: unknown): WidgetPresetId | undefined {
  if (value === undefined) return undefined;
  const id = parseString(value, "preset", 64);
  if (!isWidgetPresetId(id)) {
    throw new WidgetConfigError(
      `preset must be one of: ${WIDGET_PRESET_IDS.join(", ")}`,
    );
  }
  return id;
}

function parseRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new WidgetConfigError("revision must be a non-negative integer");
  }
  return value;
}

export function parseVoiceThereWidgetConfigV1(
  input: unknown,
): VoiceThereWidgetConfigV1 {
  if (!isPlainObject(input)) {
    throw new WidgetConfigError("Config must be a JSON object");
  }

  assertNoSecretLikeKeys(input);
  rejectUnknownKeys(input, ALLOWED_TOP_LEVEL_KEYS, "");

  if (input.v !== WIDGET_CONFIG_VERSION) {
    throw new WidgetConfigError(`Config v must be ${WIDGET_CONFIG_VERSION}`);
  }

  return {
    v: WIDGET_CONFIG_VERSION,
    publicId: parseOptionalString(
      input.publicId,
      "publicId",
      MAX_PUBLIC_ID_LEN,
    ),
    projectId: parseOptionalString(
      input.projectId,
      "projectId",
      MAX_PROJECT_ID_LEN,
    ),
    apiBase: parseOptionalString(input.apiBase, "apiBase", MAX_API_BASE_LEN),
    revision: parseRevision(input.revision),
    preset: parsePreset(input.preset),
    theme: parseTheme(input.theme),
    launcherLabel: parseOptionalString(
      input.launcherLabel,
      "launcherLabel",
      MAX_LAUNCHER_LABEL_LEN,
    ),
    greeting: parseOptionalString(input.greeting, "greeting", MAX_GREETING_LEN),
    position: parsePosition(input.position),
    positionOffset: parsePositionOffset(input.positionOffset),
    customCss: parseCustomCss(input.customCss),
    mode: parseMode(input.mode),
    streamSpokenText: parseStreamSpokenText(input.streamSpokenText),
  };
}

export function parseVoiceThereWidgetConfigJson(
  json: string,
): VoiceThereWidgetConfigV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new WidgetConfigError("Config JSON is invalid");
  }
  return parseVoiceThereWidgetConfigV1(parsed);
}

export function widgetConfigModeToSessionMode(
  mode: WidgetConfigMode | undefined,
): BrowserSessionMode | undefined {
  if (mode === undefined) return undefined;
  return mode === "voice"
    ? BrowserSessionModeType.Voice
    : BrowserSessionModeType.Chat;
}

export async function fetchVoiceThereWidgetConfig(
  configUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VoiceThereWidgetConfigV1> {
  const url = parseString(configUrl, "configUrl", MAX_API_BASE_LEN);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new WidgetConfigError(`Failed to fetch config from ${url}`);
  }
  if (!response.ok) {
    throw new WidgetConfigError(
      `Config fetch failed (${response.status}) from ${url}`,
    );
  }
  const text = await response.text();
  return parseVoiceThereWidgetConfigJson(text);
}
