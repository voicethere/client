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

export function widgetBootstrapCdnUrl(
  cdnBase: string,
  keySha256Hex: string,
): string {
  const base = cdnBase.replace(/\/+$/, "");
  return `${base}/widgets/by-key/${keySha256Hex}/bootstrap.json`;
}
