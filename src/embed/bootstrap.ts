import {
  parseVoiceThereWidgetConfigV1,
  WidgetConfigError,
  type VoiceThereWidgetConfigV1,
} from "./config.js";
import {
  DEFAULT_WIDGET_API_BASE,
  resolveWidgetCdnBase,
  widgetBootstrapCdnUrl,
} from "./hosts.js";
import { sha256HexUtf8 } from "./widget-key-hash.js";

/** Bootstrap JSON published at CDN `widgets/by-key/{sha256}/bootstrap.json`. */
export type WidgetBootstrapDocumentV1 = {
  project_id: string;
  api_base: string;
  public_id: string;
  published: boolean;
  published_revision: number;
  widget: VoiceThereWidgetConfigV1 | null;
};

export type WidgetBootstrapIdentity = {
  projectId: string;
  apiBase: string;
};

export class WidgetBootstrapError extends Error {
  readonly name = "WidgetBootstrapError";
}

/** Client-side cache TTL (sessionStorage) for repeat page loads. */
export const WIDGET_BOOTSTRAP_SESSION_CACHE_MS = 10 * 60 * 1000;

const SESSION_CACHE_PREFIX = "vt-widget-bootstrap:";

function clientKeyCachePrefix(clientKey: string): string {
  const trimmed = clientKey.trim();
  if (trimmed.length <= 16) return trimmed;
  return trimmed.slice(0, 16);
}

export function widgetBootstrapSessionCacheKey(
  cdnBase: string,
  clientKey: string,
): string {
  return `${SESSION_CACHE_PREFIX}${cdnBase}:${clientKeyCachePrefix(clientKey)}`;
}

type CachedBootstrapPayload = {
  expiresAt: number;
  document: WidgetBootstrapDocumentV1;
};

function readSessionStorage(): Storage | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

function readCachedBootstrap(
  cacheKey: string,
  nowMs: number,
): WidgetBootstrapDocumentV1 | null {
  const storage = readSessionStorage();
  if (!storage) return null;
  const raw = storage.getItem(cacheKey);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    storage.removeItem(cacheKey);
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as CachedBootstrapPayload).expiresAt !== "number" ||
    (parsed as CachedBootstrapPayload).expiresAt <= nowMs
  ) {
    storage.removeItem(cacheKey);
    return null;
  }
  return (parsed as CachedBootstrapPayload).document;
}

function writeCachedBootstrap(
  cacheKey: string,
  document: WidgetBootstrapDocumentV1,
  nowMs: number,
): void {
  const storage = readSessionStorage();
  if (!storage) return;
  const payload: CachedBootstrapPayload = {
    expiresAt: nowMs + WIDGET_BOOTSTRAP_SESSION_CACHE_MS,
    document,
  };
  storage.setItem(cacheKey, JSON.stringify(payload));
}

function parseStringField(
  value: unknown,
  field: string,
  maxLen: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WidgetBootstrapError(`${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLen) {
    throw new WidgetBootstrapError(`${field} is too long`);
  }
  return trimmed;
}

export function parseWidgetBootstrapDocument(
  input: unknown,
): WidgetBootstrapDocumentV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WidgetBootstrapError("Bootstrap must be a JSON object");
  }
  const record = input as Record<string, unknown>;
  const project_id = parseStringField(record.project_id, "project_id", 64);
  const api_base = parseStringField(record.api_base, "api_base", 512);
  const public_id = parseStringField(record.public_id, "public_id", 128);
  if (typeof record.published !== "boolean") {
    throw new WidgetBootstrapError("published must be a boolean");
  }
  if (
    typeof record.published_revision !== "number" ||
    !Number.isInteger(record.published_revision) ||
    record.published_revision < 0
  ) {
    throw new WidgetBootstrapError(
      "published_revision must be a non-negative integer",
    );
  }
  let widget: VoiceThereWidgetConfigV1 | null = null;
  if (record.widget !== null) {
    if (record.widget === undefined) {
      throw new WidgetBootstrapError("widget must be null or an object");
    }
    try {
      widget = parseVoiceThereWidgetConfigV1(record.widget);
    } catch (error) {
      const detail =
        error instanceof WidgetConfigError || error instanceof Error
          ? error.message
          : String(error);
      throw new WidgetBootstrapError(`widget: ${detail}`);
    }
  }
  return {
    project_id,
    api_base,
    public_id,
    published: record.published,
    published_revision: record.published_revision,
    widget,
  };
}

export function parseWidgetBootstrapJson(
  json: string,
): WidgetBootstrapDocumentV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new WidgetBootstrapError("Bootstrap JSON is invalid");
  }
  return parseWidgetBootstrapDocument(parsed);
}

export function bootstrapIdentityFromDocument(
  document: WidgetBootstrapDocumentV1,
): WidgetBootstrapIdentity {
  return {
    projectId: document.project_id,
    apiBase: document.api_base,
  };
}

export type FetchWidgetBootstrapOptions = {
  clientKey: string;
  apiBase?: string;
  cdnBase?: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
};

export async function fetchWidgetBootstrapByClientKey(
  options: FetchWidgetBootstrapOptions,
): Promise<WidgetBootstrapDocumentV1> {
  const clientKey = options.clientKey.trim();
  if (!clientKey) {
    throw new WidgetBootstrapError("clientKey is required");
  }
  const apiBase = options.apiBase?.trim() || DEFAULT_WIDGET_API_BASE;
  const cdnBase = options.cdnBase?.trim() || resolveWidgetCdnBase(apiBase);
  const cacheKey = widgetBootstrapSessionCacheKey(cdnBase, clientKey);
  const nowMs = options.nowMs ?? Date.now();
  const cached = readCachedBootstrap(cacheKey, nowMs);
  if (cached) {
    return cached;
  }

  const keyHex = await sha256HexUtf8(clientKey);
  const url = widgetBootstrapCdnUrl(cdnBase, keyHex);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new WidgetBootstrapError(`Failed to fetch bootstrap from ${url}`);
  }
  if (!response.ok) {
    throw new WidgetBootstrapError(
      `Bootstrap fetch failed (${response.status}) from ${url}`,
    );
  }
  const text = await response.text();
  const document = parseWidgetBootstrapJson(text);
  writeCachedBootstrap(cacheKey, document, nowMs);
  return document;
}
