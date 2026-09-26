import { describe, expect, it } from "vitest";

import {
  sha256HexUtf8,
  WIDGET_KEY_HASH_FIXTURE_HEX,
  WIDGET_KEY_HASH_FIXTURE_RAW,
} from "./widget-key-hash.js";

describe("widget-key-hash", () => {
  it("matches platform fixture for vthc_test", async () => {
    await expect(sha256HexUtf8(WIDGET_KEY_HASH_FIXTURE_RAW)).resolves.toBe(
      WIDGET_KEY_HASH_FIXTURE_HEX,
    );
  });
});
