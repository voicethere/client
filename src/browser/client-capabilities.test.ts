import { describe, expect, it } from "vitest";

import { CLIENT_CAPABILITIES } from "./client-capabilities.js";
// Entry re-exports (source) — release check: dist/browser + dist/node must export the same.
import { CLIENT_CAPABILITIES as fromBrowserSession } from "./browser-session.js";

describe("CLIENT_CAPABILITIES", () => {
  it("advertises iceTransportPolicy from source module", () => {
    expect(CLIENT_CAPABILITIES.iceTransportPolicy).toBe(true);
  });

  it("is re-exported from browser-session entry source", () => {
    expect(fromBrowserSession.iceTransportPolicy).toBe(true);
  });
});

/**
 * Release check (manual / CI after build):
 *   node -e "import('./dist/browser/browser-session.js').then(m => console.log(m.CLIENT_CAPABILITIES))"
 *   node -e "import('./dist/node/index.js').then(m => console.log(m.CLIENT_CAPABILITIES))"
 */
