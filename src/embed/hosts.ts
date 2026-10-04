export const DEFAULT_WIDGET_API_BASE = "https://sessions.voicethere.io/v1";

export const DEFAULT_WIDGET_CDN_BASE = "https://cdn.voicethere.io";

export const STAGING_WIDGET_CDN_BASE = "https://cdn.voicethere.dev";

/** Pair CDN host with session API host (staging vs production). */
export function resolveWidgetCdnBase(apiBase?: string): string {
  const resolvedApiBase = apiBase?.trim() || DEFAULT_WIDGET_API_BASE;
  try {
    const host = new URL(resolvedApiBase).hostname;
    if (host === "sessions.voicethere.dev") {
      return STAGING_WIDGET_CDN_BASE;
    }
  } catch {
    /* invalid URL — production CDN default */
  }
  return DEFAULT_WIDGET_CDN_BASE;
}

function trimTrailingSlashes(cdnBase: string): string {
  let end = cdnBase.length;
  while (end > 0 && cdnBase.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return cdnBase.slice(0, end);
}

const WIDGET_PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** True when `value` is safe to use as a CDN path segment for a project. */
export function isValidWidgetPublicId(value: unknown): value is string {
  return typeof value === "string" && WIDGET_PUBLIC_ID_PATTERN.test(value);
}

/** Legacy per-key bootstrap URL. */
// LEGACY(widget-by-key): remove once all deployments serve key-map pointers.
export function widgetBootstrapCdnUrl(
  cdnBase: string,
  keySha256Hex: string,
): string {
  return `${trimTrailingSlashes(cdnBase)}/widgets/by-key/${keySha256Hex}/bootstrap.json`;
}

/** Immutable pointer from a client key hash to its project `public_id`. */
export function widgetKeyMapUrl(cdnBase: string, keySha256Hex: string): string {
  return `${trimTrailingSlashes(cdnBase)}/widgets/key-map/${keySha256Hex}.json`;
}

/** Project-level bootstrap document shared by all of a project's keys. */
export function widgetProjectBootstrapUrl(
  cdnBase: string,
  publicId: string,
): string {
  if (!isValidWidgetPublicId(publicId)) {
    throw new Error("Invalid widget public_id");
  }
  return `${trimTrailingSlashes(cdnBase)}/widgets/${publicId}/bootstrap.json`;
}
