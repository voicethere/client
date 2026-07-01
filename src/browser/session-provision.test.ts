import { describe, expect, it } from "vitest";

import {
  isCapacityWaitStatus,
  isTerminalSessionJobStatus,
  type SessionStatusResponse,
} from "./session-provision.js";

describe("session provision state machine", () => {
  it("treats ready and failed as terminal", () => {
    expect(isTerminalSessionJobStatus("ready")).toBe(true);
    expect(isTerminalSessionJobStatus("failed")).toBe(true);
    expect(isTerminalSessionJobStatus("queued")).toBe(false);
    expect(isTerminalSessionJobStatus("waiting")).toBe(false);
    expect(isTerminalSessionJobStatus("provisioning")).toBe(false);
  });

  it("detects capacity wait polling status", () => {
    const waiting: SessionStatusResponse = {
      session_id: "job-1",
      status: "waiting",
      project_id: "550e8400-e29b-41d4-a716-446655440000",
      build_id: null,
      queue_position: 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(isCapacityWaitStatus(waiting)).toBe(true);
    expect(isCapacityWaitStatus({ ...waiting, status: "provisioning" })).toBe(
      false,
    );
  });
});
