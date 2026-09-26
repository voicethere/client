/** Documented cross-runtime fixture (must match platform widget-key-hash). */
export const WIDGET_KEY_HASH_FIXTURE_RAW = "vthc_test";

/** SHA-256 hex of {@link WIDGET_KEY_HASH_FIXTURE_RAW}. */
export const WIDGET_KEY_HASH_FIXTURE_HEX =
  "63cf236ad0dfc11450b3fc2229db40c1db7bc127493f832dc9cda5a27fae1878";

function bytesToLowerHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * SHA-256 digest of a UTF-8 string, lowercase hex (64 chars).
 * Matches platform `sha256HexUtf8` (UTF-8 → SHA-256 → hex).
 */
export async function sha256HexUtf8(rawUtf8: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const data = new TextEncoder().encode(rawUtf8);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return bytesToLowerHex(digest);
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(rawUtf8, "utf8").digest("hex");
}
