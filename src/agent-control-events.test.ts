import { describe, expect, it } from "vitest";

import {
  parseAgentContentEvent,
  parseAgentFillerEvent,
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

describe("parseAgentContentEvent", () => {
  const URL = "https://app.voicethere.dev/docs/pricing";

  it("parses a spoken link with label and inReplyTo", () => {
    expect(
      parseAgentContentEvent({
        type: "assistant_content",
        turnId: "t1",
        inReplyTo: "utt-1",
        spoken: true,
        content: { kind: "link", url: URL, label: " Pricing " },
      }),
    ).toEqual({
      turnId: "t1",
      inReplyTo: "utt-1",
      spoken: true,
      content: { kind: "link", url: URL, label: "Pricing" },
    });
  });

  it("parses a chat link without label as not spoken", () => {
    expect(
      parseAgentContentEvent({
        type: "assistant_content",
        turnId: "t2",
        content: { kind: "link", url: URL },
      }),
    ).toEqual({
      turnId: "t2",
      spoken: false,
      content: { kind: "link", url: URL },
    });
  });

  it("ignores unknown kinds, non-https links, bad URLs and a missing turnId", () => {
    const base = { type: "assistant_content", turnId: "t" };
    expect(
      parseAgentContentEvent({ ...base, content: { kind: "image", url: URL } }),
    ).toBeNull();
    expect(
      parseAgentContentEvent({
        ...base,
        content: { kind: "link", url: "http://example.com" },
      }),
    ).toBeNull();
    expect(
      parseAgentContentEvent({
        ...base,
        content: { kind: "link", url: "javascript:alert(1)" },
      }),
    ).toBeNull();
    expect(
      parseAgentContentEvent({
        ...base,
        content: { kind: "link", url: "not a url" },
      }),
    ).toBeNull();
    expect(
      parseAgentContentEvent({
        type: "assistant_content",
        content: { kind: "link", url: URL },
      }),
    ).toBeNull();
    expect(
      parseAgentContentEvent({
        type: "assistant_delta",
        turnId: "t",
        text: URL,
      }),
    ).toBeNull();
  });

  it("rejects a url longer than 2048 chars and accepts one of exactly 2048", () => {
    const at = (url: string) =>
      parseAgentContentEvent({
        type: "assistant_content",
        turnId: "t",
        content: { kind: "link", url },
      });
    const long = "https://a.dev/" + "x".repeat(2040);
    expect(long).toHaveLength(2054);
    expect(at(long)).toBeNull();
    const max = "https://a.dev/" + "x".repeat(2034);
    expect(max).toHaveLength(2048);
    expect(at(max)?.content.url).toBe(max);
  });

  it("caps the label at 200 chars and drops a blank label", () => {
    const at = (label: string) =>
      parseAgentContentEvent({
        type: "assistant_content",
        turnId: "t",
        content: { kind: "link", url: URL, label },
      });
    expect(at("  " + "L".repeat(250))?.content.label).toHaveLength(200);
    expect(at("   ")?.content).toEqual({ kind: "link", url: URL });
  });
});

describe("parseAgentFillerEvent", () => {
  it("parses a filler with turnId and text", () => {
    expect(
      parseAgentFillerEvent({
        type: "assistant_filler",
        turnId: "t1",
        text: "One moment.",
      }),
    ).toEqual({ turnId: "t1", text: "One moment." });
  });

  it("ignores other types and malformed messages", () => {
    const bad: Record<string, unknown>[] = [
      { type: "assistant_delta", turnId: "t1", text: "hi" },
      { type: "assistant_filler", text: "One moment." },
      { type: "assistant_filler", turnId: "", text: "One moment." },
      { type: "assistant_filler", turnId: 7, text: "One moment." },
      { type: "assistant_filler", turnId: "t1" },
      { type: "assistant_filler", turnId: "t1", text: 42 },
      { type: "assistant_filler", turnId: "t1", text: "   " },
    ];
    for (const payload of bad) {
      expect(parseAgentFillerEvent(payload)).toBeNull();
    }
  });
});
