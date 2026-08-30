import type { BrowserSessionMode } from "../browser/browser-session.js";
import { BrowserSessionModeType } from "../browser/browser-session.js";

export type VoiceThereWidgetTheme = {
  primary?: string;
  background?: string;
  text?: string;
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

export type WidgetPosition = "bottom-right" | "bottom-left";

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
  mode?: WidgetConfigMode;
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
  "mode",
]);

const ALLOWED_THEME_KEYS = new Set(["primary", "background", "text"]);

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

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export class WidgetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WidgetConfigError";
  }
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

function parseString(
  value: unknown,
  field: string,
  maxLen: number,
): string {
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
  return theme;
}

function parsePosition(value: unknown): WidgetPosition | undefined {
  if (value === undefined) return undefined;
  if (value !== "bottom-right" && value !== "bottom-left") {
    throw new WidgetConfigError(
      'position must be "bottom-right" or "bottom-left"',
    );
  }
  return value;
}

function parseMode(value: unknown): WidgetConfigMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "chat" && value !== "voice") {
    throw new WidgetConfigError('mode must be "chat" or "voice"');
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
    publicId: parseOptionalString(input.publicId, "publicId", MAX_PUBLIC_ID_LEN),
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
    mode: parseMode(input.mode),
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
