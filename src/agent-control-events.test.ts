import { describe, expect, it } from "vitest";

import {
  parseAgentInterruptedEvent,
  parseAgentStateEvent,
} from "./agent-control-events.js";

describe("agent control events", () => {
  it("parses agent_state with a valid state and keeps a short detail", () => {
    expect(
      parseAgentStateEvent({
        type: "agent_state",
        state: "tool_call",
        detail: "lookup",
      }),
    ).toEqual({ state: "tool_call", detail: "lookup" });
    expect(
      parseAgentStateEvent({ type: "agent_state", state: "listening" }),
    ).toEqual({ state: "listening" });
  });

  it("rejects agent_state with an unknown state", () => {
    expect(
      parseAgentStateEvent({ type: "agent_state", state: "dancing" }),
    ).toBeNull();
    expect(
      parseAgentStateEvent({ type: "other", state: "thinking" }),
    ).toBeNull();
  });

  it("cuts agent_state detail to 64 characters", () => {
    const event = parseAgentStateEvent({
      type: "agent_state",
      state: "thinking",
      detail: "x".repeat(100),
    });
    expect(event?.detail).toBe("x".repeat(64));
  });

  it("parses agent_interrupted and rounds replyPlayedMs", () => {
    expect(
      parseAgentInterruptedEvent({
        type: "agent_interrupted",
        turnId: "t1",
        replyPlayedMs: 1234.6,
        playedTextExact: true,
      }),
    ).toEqual({ turnId: "t1", replyPlayedMs: 1235, playedTextExact: true });
    expect(
      parseAgentInterruptedEvent({
        type: "agent_interrupted",
        turnId: "",
        replyPlayedMs: 0,
      }),
    ).toEqual({ replyPlayedMs: 0, playedTextExact: false });
  });

  it("rejects agent_interrupted without a numeric replyPlayedMs", () => {
    expect(
      parseAgentInterruptedEvent({ type: "agent_interrupted" }),
    ).toBeNull();
    expect(
      parseAgentInterruptedEvent({
        type: "agent_interrupted",
        replyPlayedMs: "12",
      }),
    ).toBeNull();
    expect(
      parseAgentInterruptedEvent({
        type: "agent_interrupted",
        replyPlayedMs: -1,
      }),
    ).toBeNull();
  });
});
