import { describe, expect, it } from "vitest";

import {
  isWebRtcConnectRetryError,
  WebRtcConnectRetryError,
} from "./webrtc-connect-retry.js";

describe("webrtc-connect-retry", () => {
  it("identifies WebRtcConnectRetryError instances", () => {
    const error = new WebRtcConnectRetryError("peer connection failed");
    expect(isWebRtcConnectRetryError(error)).toBe(true);
    expect(isWebRtcConnectRetryError(new Error("peer connection failed"))).toBe(
      false,
    );
  });
});
