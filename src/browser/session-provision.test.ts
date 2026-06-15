import { describe, expect, it } from "vitest";

import type { SessionStatusResponse } from "./browser/session-provision.js";

function terminalStatus(status: SessionJobStatus): boolean {
  return status === "ready" || status === "failed";
}

type SessionJobStatus = SessionStatusResponse["status"];

describe("session provision state machine", () => {
  it("treats ready and failed as terminal", () => {
    expect(terminalStatus("ready")).toBe(true);
    expect(terminalStatus("failed")).toBe(true);
    expect(terminalStatus("queued")).toBe(false);
    expect(terminalStatus("provisioning")).toBe(false);
  });
});
