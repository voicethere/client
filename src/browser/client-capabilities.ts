/**
 * Explicit browser-client capability flags for consumers (e2e, tooling).
 * Prefer this over inspecting installed bundle source text.
 */
export const CLIENT_CAPABILITIES = {
  /** RTCConfiguration.iceTransportPolicy is honored by connectBrowserVoiceSession. */
  iceTransportPolicy: true,
} as const;

export type ClientCapabilities = typeof CLIENT_CAPABILITIES;
