import { describe, expect, it } from "vitest";

import {
  createLocalSessionError,
  isSessionErrorEvent,
  mapProvisioningFailureCode,
  parseLegacyAgentError,
} from "../src/session-errors.js";

describe("session-errors", () => {
  it("recognizes session_error envelope", () => {
    expect(
      isSessionErrorEvent({
        type: "session_error",
        code: "AGENT_CHILD_CRASHED",
        message: "boom",
        session_id: "sess-1",
      }),
    ).toBe(true);
    expect(isSessionErrorEvent({ type: "chat", text: "hi" })).toBe(false);
  });

  it("maps legacy agent_error", () => {
    const event = parseLegacyAgentError(
      { type: "agent_error", message: "handler failed" },
      "room-1",
    );
    expect(event).toMatchObject({
      type: "session_error",
      code: "AGENT_CHILD_CRASHED",
      message: "handler failed",
      session_id: "room-1",
    });
  });

  it("maps provisioning timeout", () => {
    expect(mapProvisioningFailureCode("TIMEOUT")).toBe("PROVISIONING_TIMEOUT");
    expect(mapProvisioningFailureCode("NOT_DEPLOYED")).toBe(
      "PROVISIONING_FAILED",
    );
  });

  it("creates local session errors", () => {
    const event = createLocalSessionError({
      code: "WEBRTC_CONNECTION_FAILED",
      message: "pc failed",
      sessionId: "s1",
      projectId: "p1",
    });
    expect(event.code).toBe("WEBRTC_CONNECTION_FAILED");
    expect(event.project_id).toBe("p1");
  });
});
