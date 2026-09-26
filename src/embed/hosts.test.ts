import { describe, expect, it } from "vitest";

import {
  DEFAULT_WIDGET_API_BASE,
  DEFAULT_WIDGET_CDN_BASE,
  resolveWidgetCdnBase,
  STAGING_WIDGET_CDN_BASE,
  widgetBootstrapCdnUrl,
} from "./hosts.js";
import { WIDGET_KEY_HASH_FIXTURE_HEX } from "./widget-key-hash.js";

describe("embed hosts", () => {
  it("defaults production api and CDN bases", () => {
    expect(DEFAULT_WIDGET_API_BASE).toBe("https://sessions.voicethere.io/v1");
    expect(DEFAULT_WIDGET_CDN_BASE).toBe("https://cdn.voicethere.io");
    expect(resolveWidgetCdnBase()).toBe(DEFAULT_WIDGET_CDN_BASE);
  });

  it("pairs staging session host with staging CDN", () => {
    expect(resolveWidgetCdnBase("https://sessions.voicethere.dev/v1")).toBe(
      STAGING_WIDGET_CDN_BASE,
    );
  });

  it("strips trailing slashes from the CDN base", () => {
    expect(
      widgetBootstrapCdnUrl(
        "https://cdn.voicethere.io///",
        WIDGET_KEY_HASH_FIXTURE_HEX,
      ),
    ).toBe(
      `https://cdn.voicethere.io/widgets/by-key/${WIDGET_KEY_HASH_FIXTURE_HEX}/bootstrap.json`,
    );
  });

  it("builds bootstrap CDN URL shape", () => {
    expect(
      widgetBootstrapCdnUrl(
        "https://cdn.voicethere.io",
        WIDGET_KEY_HASH_FIXTURE_HEX,
      ),
    ).toBe(
      `https://cdn.voicethere.io/widgets/by-key/${WIDGET_KEY_HASH_FIXTURE_HEX}/bootstrap.json`,
    );
  });
});
